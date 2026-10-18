/**
 * OpenChip core data model.
 *
 * This mirrors the `.openchip` file format. New features EXTEND these types —
 * they never replace them. When adding a field, prefer an
 * optional field with a sensible default in `lib/defaults.ts` so that older
 * project files keep loading (see `migrateProject` in `lib/projectFile.ts`).
 *
 * Units: every physical measurement is millimetres (mm) unless the field name
 * says otherwise (e.g. `xyResolutionMicrons`). Coordinates follow the
 * Three.js / manifold-3d convention: +Z up.
 */

/** Bumped when the on-disk shape changes in a way that needs migration. */
export const OPENCHIP_FORMAT_VERSION = 1;

// ---------------------------------------------------------------------------
// meta
// ---------------------------------------------------------------------------

export type Units = 'mm';

export interface ProjectMeta {
  name: string;
  /** ISO-8601 timestamp. */
  createdAt: string;
  /** ISO-8601 timestamp. */
  modifiedAt: string;
  units: Units;
}

// ---------------------------------------------------------------------------
// printerProfile
// ---------------------------------------------------------------------------

export interface Vec3Mm {
  x: number;
  y: number;
  z: number;
}

export interface PrinterProfile {
  name: string;
  /** Pixel pitch in the XY plane, microns. */
  xyResolutionMicrons: number;
  /** Z step per layer, microns. */
  layerHeightMicrons: number;
  /**
   * Smallest feature the printer can reliably resolve, mm. The design checks warn when
   * a channel drops below this.
   */
  minFeatureSizeMm: number;
  buildVolumeMm: Vec3Mm;
}

// ---------------------------------------------------------------------------
// chipParams
// ---------------------------------------------------------------------------

export type SplitType = 'two-piece' | 'monolithic' | 'glass-slide';

/**
 * A glass microscope slide dropped into a pocket over the channels.
 *
 * The chip prints open-faced — the channels are grooves with no roof — and the
 * slide becomes the roof once it is bonded on. Every figure is editable
 * because "microscope slide" is not one size: 75 × 25 mm is the common one,
 * but 76 × 26 and 75 × 50 are both sold, and thickness runs 1.0–1.2 mm.
 */
export interface SlideParams {
  /** Slide footprint along X, mm. */
  widthMm: number;
  /** Slide footprint along Y, mm. */
  lengthMm: number;
  /** Slide thickness, mm. */
  thicknessMm: number;
  /** Extra pocket size per side, so the glass drops in rather than presses in. */
  clearanceMm: number;
  /** Extra pocket depth beneath the glass, for adhesive or a resin bond line. */
  bondGapMm: number;
  /** Pocket offset from the middle of the chip, mm. */
  offsetXMm: number;
  offsetYMm: number;
}

export interface ChipParams {
  /** Chip footprint along X, mm. */
  width: number;
  /** Chip footprint along Y, mm. */
  length: number;
  /** Total block height, mm. */
  baseThickness: number;
  /** Minimum solid material between a channel and anything else, mm. */
  wallThickness: number;
  /** Minimum clearance from a channel to the chip boundary, mm. */
  minEdgeSpacing: number;
  splitType: SplitType;
  /**
   * Z height of the cut plane for `two-piece`, mm. Meaningless (but retained)
   * when `splitType` is `monolithic`.
   *
   * Ignored by `glass-slide`, which derives the plane from the pocket floor —
   * the channels have to open onto the surface the glass lands on, so there is
   * nothing left for this to decide. `slidePocket` owns that arithmetic.
   */
  splitHeight: number;
  /** Glass slide geometry. Only used when `splitType` is `glass-slide`. */
  slide: SlideParams;

  // --- channel defaults ----------------------------------------------------
  // Applied to newly drawn edges. An edge with no `dimensionPoints` uses these
  // everywhere; the moment the user drops a dimension marker, that edge is
  // driven by its markers instead.

  /** Default channel width for new edges, mm. */
  defaultChannelWidthMm: number;
  /** Default channel height for new edges, mm. Unused by `round`. */
  defaultChannelHeightMm: number;
  /** Cross-section assigned to new edges. */
  defaultCrossSection: CrossSection;
}

// ---------------------------------------------------------------------------
// channelGraph — nodes
// ---------------------------------------------------------------------------

export type NodeType = 'waypoint' | 'port' | 'chamber';
/**
 * `luer` and `luer-lock` are female sockets cut into the chip; `luer-male` and
 * `barb` are male fittings that stand proud of it. The distinction matters to
 * the geometry pipeline — a socket is subtracted, a spigot is added.
 */
export type PortType = 'syringe' | 'luer' | 'luer-lock' | 'luer-male' | 'barb' | 'custom';
export type ChamberShape = 'sphere' | 'cylinder';

interface NodeBase {
  id: string;
  /** Position in chip-space mm, origin at the chip's bottom-left corner. */
  x: number;
  y: number;
}

/** A plain vertex in the channel path. */
export interface WaypointNode extends NodeBase {
  type: 'waypoint';
}

/** An inlet or outlet where fluid enters or leaves the chip. */
export interface PortNode extends NodeBase {
  type: 'port';
  portType: PortType;
  /** Bore diameter, mm. */
  diameterMm: number;
  /**
   * Free-form dimensions for `portType: 'custom'`, and any user overrides of a
   * standard fitting. Kept open-ended so the port picker can add fields
   * without a format bump.
   */
  customSpec?: Record<string, number | string>;
}

/** A mixing chamber — an enlarged volume placed at a junction or turn. */
export interface ChamberNode extends NodeBase {
  type: 'chamber';
  shape: ChamberShape;
  /** Diameter for a sphere, diameter for a cylinder, mm. */
  sizeMm: number;
  /** True when placed by the "add chambers at all corners" action. */
  autoPlaced: boolean;
}

export type ChannelNode = WaypointNode | PortNode | ChamberNode;

// ---------------------------------------------------------------------------
// channelGraph — edges
// ---------------------------------------------------------------------------

export type CurveType = 'straight' | 'bezier';
export type CrossSection = 'round' | 'rect' | 'trapezoid';

export interface Point2 {
  x: number;
  y: number;
}

/**
 * A local channel size at parameter `t` along an edge. Consecutive dimension
 * points define a loft: the solid generator interpolates size between them,
 * and across a connected chain of edges.
 */
export interface DimensionPoint {
  /** Normalised position along the edge, 0 at `fromNodeId`, 1 at `toNodeId`. */
  t: number;
  widthMm: number;
  /** Omitted for `round`, where width is the diameter. */
  heightMm?: number;
}

export interface ChannelEdge {
  id: string;
  fromNodeId: string;
  toNodeId: string;
  curveType: CurveType;
  /** Bezier handles, in chip-space mm. Present only when `curveType` is `bezier`. */
  controlPoints?: Point2[];
  crossSection: CrossSection;
  dimensionPoints: DimensionPoint[];
}

export interface ChannelGraph {
  nodes: ChannelNode[];
  edges: ChannelEdge[];
}

// ---------------------------------------------------------------------------
// fluidProfiles
// ---------------------------------------------------------------------------

/**
 * A working fluid.
 *
 * Exactly the property set the flow estimates consume — density and
 * viscosity for pressure drop and Reynolds number, conductivity and specific
 * heat for the wall heat exchange, and the inlet temperature as the thermal
 * boundary condition. Prandtl number is derived, not stored.
 */
export interface FluidProfile {
  id: string;
  name: string;
  /** False for user-created fluids. */
  builtIn: boolean;

  densityKgM3: number;
  dynamicViscosityPaS: number;
  thermalConductivityWmK: number;
  specificHeatCapacityJkgK: number;
  /** Default inlet temperature, °C. An inlet assignment may override it per run. */
  inletTemperatureC: number;

  /** Set on glycerol/water blends so the UI can offer the percentage control. */
  glycerolVolumePercent?: number;
  /** Free-text caveat shown under the fields. */
  note?: string;
  /** Shown prominently when the real fluid is meaningfully non-Newtonian. */
  nonNewtonianNote?: string;
}

// ---------------------------------------------------------------------------
// fluidSetup
// ---------------------------------------------------------------------------

export type PortRole = 'inlet' | 'outlet';

/** How one port participates in a simulation run. */
export interface FluidAssignment {
  portId: string;
  role: PortRole;
  /** Which fluid enters here. Meaningless for an outlet. */
  fluidProfileId: string | null;
  /** Volumetric flow into the chip, µL/min. Inlets only. */
  flowRateUlPerMin: number;
  /** Overrides the profile's temperature for this run. Null uses the profile's. */
  inletTemperatureC: number | null;
}

export interface FluidSetup {
  assignments: FluidAssignment[];
  /**
   * Thermal conductivity of the printed chip, W/m·K. Governs how readily heat
   * crosses the wall between two channels. Standard photopolymer resin is
   * around 0.2.
   */
  chipMaterialThermalConductivityWmK: number;
}

// ---------------------------------------------------------------------------
// drainageVents
// ---------------------------------------------------------------------------

/**
 * A small hole from a channel to the chip surface, so uncured resin can be
 * flushed out of an enclosed cavity.
 *
 * Anchored to a node rather than to free coordinates, so a vent follows the
 * channel when the user drags it and disappears cleanly when the node is
 * deleted — a vent floating in solid material would be worse than none.
 */
export interface DrainageVent {
  id: string;
  nodeId: string;
  diameterMm: number;
  /** True when placed by the "add drainage holes" helper rather than by hand. */
  autoPlaced: boolean;
}

// ---------------------------------------------------------------------------
// savedImages
// ---------------------------------------------------------------------------

export type SavedImageKind = 'schematic-svg' | 'cad-snapshot' | 'heatmap';

export interface SavedImage {
  id: string;
  kind: SavedImageKind;
  label: string;
  /** ISO-8601 timestamp. */
  createdAt: string;
  /** MIME type of `data`, e.g. `image/svg+xml` or `image/png`. */
  mimeType: string;
  /** Data URI. Kept inline so a `.openchip` file stays a single portable file. */
  data: string;
}

// ---------------------------------------------------------------------------
// the project
// ---------------------------------------------------------------------------

export interface OpenChipProject {
  /** Format version of this file — see `OPENCHIP_FORMAT_VERSION`. */
  formatVersion: number;
  meta: ProjectMeta;
  printerProfile: PrinterProfile;
  chipParams: ChipParams;
  channelGraph: ChannelGraph;
  fluidProfiles: FluidProfile[];
  /** Port roles, fluid assignments and chip material. */
  fluidSetup: FluidSetup;
  savedImages: SavedImage[];
  /** Drainage holes for enclosed cavities. */
  drainageVents: DrainageVent[];
  /** Id of the starter template this project began from, if any. */
  presetLibraryRef: string | null;
}

// ---------------------------------------------------------------------------
// narrowing helpers
// ---------------------------------------------------------------------------

export const isPortNode = (n: ChannelNode): n is PortNode => n.type === 'port';
export const isChamberNode = (n: ChannelNode): n is ChamberNode => n.type === 'chamber';
export const isWaypointNode = (n: ChannelNode): n is WaypointNode => n.type === 'waypoint';
