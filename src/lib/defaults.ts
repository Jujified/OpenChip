/**
 * Factory defaults: printer presets, chip parameter defaults, and the
 * new-project constructor.
 */

import {
  OPENCHIP_FORMAT_VERSION,
  type ChannelGraph,
  type ChipParams,
  type FluidProfile,
  type FluidSetup,
  type OpenChipProject,
  type PrinterProfile,
  type SlideParams,
} from '../types/project';

// ---------------------------------------------------------------------------
// ids
// ---------------------------------------------------------------------------

/** `crypto.randomUUID` needs a secure context; localhost qualifies, file:// may not. */
export function newId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `id-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

// ---------------------------------------------------------------------------
// printer presets
// ---------------------------------------------------------------------------

export interface PrinterPreset {
  id: string;
  /** Shown in the onboarding picker. */
  headline: string;
  /** One-line plain-English explanation for a non-CAD user. */
  blurb: string;
  /** Representative hardware, to help a user recognise their own printer. */
  examples: string;
  profile: PrinterProfile;
}

/**
 * `minFeatureSizeMm` is a conservative rule of thumb — roughly 5–6 exposure
 * pixels — for a feature that survives washing and curing. It is a starting
 * point, not a hard limit; every field stays editable.
 */
export const PRINTER_PRESETS: PrinterPreset[] = [
  {
    id: 'standard-4k',
    headline: 'Standard 4K resin printer',
    blurb: 'The common desktop mSLA size. A good default if you are not sure.',
    examples: 'Elegoo Mars 4, Anycubic Photon Mono 4K, Creality Halot One',
    profile: {
      name: 'Standard 4K resin printer',
      xyResolutionMicrons: 35,
      layerHeightMicrons: 50,
      minFeatureSizeMm: 0.2,
      buildVolumeMm: { x: 143, y: 89, z: 175 },
    },
  },
  {
    id: 'high-res-8k',
    headline: 'High-resolution 8K / 12K',
    blurb: 'Finer pixel pitch — better for narrow channels and crisp port threads.',
    examples: 'Elegoo Saturn 4 Ultra, Anycubic Photon Mono M5s, Phrozen Sonic Mini 8K',
    profile: {
      name: 'High-resolution 8K / 12K',
      xyResolutionMicrons: 20,
      layerHeightMicrons: 30,
      minFeatureSizeMm: 0.12,
      buildVolumeMm: { x: 219, y: 123, z: 260 },
    },
  },
  {
    id: 'large-format',
    headline: 'Large-format resin printer',
    blurb: 'Bigger build plate, coarser pixels. Best for chips larger than ~150 mm.',
    examples: 'Elegoo Jupiter, Anycubic Photon M3 Max, Peopoly Phenom',
    profile: {
      name: 'Large-format resin printer',
      xyResolutionMicrons: 46,
      layerHeightMicrons: 50,
      minFeatureSizeMm: 0.25,
      buildVolumeMm: { x: 298, y: 165, z: 300 },
    },
  },
];

/** Seed values for the "I'll enter my own" path — the standard preset, renamed. */
export const CUSTOM_PROFILE_SEED: PrinterProfile = {
  ...PRINTER_PRESETS[0].profile,
  name: 'My printer',
};

export const FALLBACK_PRINTER_PROFILE: PrinterProfile = PRINTER_PRESETS[0].profile;

// ---------------------------------------------------------------------------
// chip parameters
// ---------------------------------------------------------------------------

/** A standard plain glass microscope slide, and a pocket that fits one. */
export const DEFAULT_SLIDE: SlideParams = {
  widthMm: 75,
  lengthMm: 25,
  thicknessMm: 1,
  // 0.2 mm per side: enough that the glass drops in on a printer holding
  // ±0.1 mm, without leaving it loose enough to slide around while it bonds.
  clearanceMm: 0.2,
  bondGapMm: 0,
  offsetXMm: 0,
  offsetYMm: 0,
};

export const DEFAULT_CHIP_PARAMS: ChipParams = {
  width: 40,
  length: 60,
  baseThickness: 4,
  wallThickness: 2,
  minEdgeSpacing: 3,
  splitType: 'two-piece',
  /** Mid-plane of the default block — where a two-piece chip bonds together. */
  splitHeight: 2,

  // A plain 75 × 25 mm slide, 1 mm thick — the size sold by the box. It does
  // not fit the 40 × 60 mm default chip, and the design checks say so with the
  // numbers rather than quietly shrinking the slide to something you cannot buy.
  slide: DEFAULT_SLIDE,

  // Comfortably above every printer preset's minFeatureSizeMm, so a freshly
  // drawn channel does not start life with a printability warning on it.
  defaultChannelWidthMm: 0.8,
  defaultChannelHeightMm: 0.5,
  defaultCrossSection: 'rect',
};

export const DEFAULT_PROJECT_NAME = 'Untitled chip';

/** Typical photopolymer resin, W/m·K. Editable in the Fluid tab. */
export const DEFAULT_CHIP_CONDUCTIVITY_WMK = 0.2;

export const createEmptyChannelGraph = (): ChannelGraph => ({ nodes: [], edges: [] });

// ---------------------------------------------------------------------------
// new project
// ---------------------------------------------------------------------------

export interface CreateProjectOptions {
  name?: string;
  printerProfile?: PrinterProfile;
  chipParams?: Partial<ChipParams>;
  presetLibraryRef?: string | null;
  /**
   * Geometry to open with, for the starter templates.
   *
   * A template is delivered as a normal new project rather than through a
   * separate "template mode": the moment it is open there is nothing left that
   * distinguishes it from a chip the user drew, which is exactly the promise
   * the library makes.
   */
  channelGraph?: ChannelGraph;
  /** Seeded so a template's Fluid Dynamics tab has numbers on first open. */
  fluidProfiles?: FluidProfile[];
  fluidSetup?: FluidSetup;
}

export function createProject(options: CreateProjectOptions = {}): OpenChipProject {
  const now = new Date().toISOString();
  return {
    formatVersion: OPENCHIP_FORMAT_VERSION,
    meta: {
      name: options.name?.trim() || DEFAULT_PROJECT_NAME,
      createdAt: now,
      modifiedAt: now,
      units: 'mm',
    },
    printerProfile: { ...(options.printerProfile ?? FALLBACK_PRINTER_PROFILE) },
    chipParams: { ...DEFAULT_CHIP_PARAMS, ...options.chipParams },
    channelGraph: options.channelGraph ?? createEmptyChannelGraph(),
    fluidProfiles: options.fluidProfiles ?? [],
    fluidSetup: options.fluidSetup ?? {
      assignments: [],
      chipMaterialThermalConductivityWmK: DEFAULT_CHIP_CONDUCTIVITY_WMK,
    },
    savedImages: [],
    drainageVents: [],
    presetLibraryRef: options.presetLibraryRef ?? null,
  };
}
