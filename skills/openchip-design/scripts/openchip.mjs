#!/usr/bin/env node
/**
 * openchip.mjs — compile and check OpenChip designs.
 *
 * Two jobs, one file, zero dependencies:
 *
 *   build <in.chip> [-o out.openchip]   compile Chip-DSL → .openchip, then check it
 *   check <file.openchip|file.chip>     run every design check and print the report
 *
 * The checks are a faithful port of `src/lib/validation/*` in the OpenChip
 * repo — same thresholds, same loft-chain arithmetic, same wording where it
 * matters. They exist so a chip written by an agent can be checked before the
 * user ever opens the app, not to replace what the app does.
 *
 * Nothing here ever blocks. A design with warnings still compiles and still
 * writes its file: OpenChip's first rule is that the user keeps final control.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { basename, extname } from 'node:path';

// ===========================================================================
// catalogues — mirrored from the app
// ===========================================================================

export const PRINTERS = {
  'standard-4k': {
    name: 'Standard 4K resin printer',
    xyResolutionMicrons: 35,
    layerHeightMicrons: 50,
    minFeatureSizeMm: 0.2,
    buildVolumeMm: { x: 143, y: 89, z: 175 },
  },
  'high-res-8k': {
    name: 'High-resolution 8K / 12K',
    xyResolutionMicrons: 20,
    layerHeightMicrons: 30,
    minFeatureSizeMm: 0.12,
    buildVolumeMm: { x: 219, y: 123, z: 260 },
  },
  'large-format': {
    name: 'Large-format resin printer',
    xyResolutionMicrons: 46,
    layerHeightMicrons: 50,
    minFeatureSizeMm: 0.25,
    buildVolumeMm: { x: 298, y: 165, z: 300 },
  },
};

const LUER_TAPER = {
  taperLargeDiameterMm: 4.27,
  taperSmallDiameterMm: 3.858, // 4.27 − 0.06 × 7.5, rounded to µm
  taperLengthMm: 7.5,
};

/** DSL fitting word → the port node it produces. Mirrors FITTING_PRESETS. */
export const FITTINGS = {
  'luer-slip': {
    portType: 'luer',
    boreMm: 1.6,
    spec: { ...LUER_TAPER, bossHeightMm: 3.5 },
  },
  'luer-lock': {
    portType: 'luer-lock',
    boreMm: 1.6,
    spec: {
      ...LUER_TAPER,
      bossHeightMm: 5,
      threadMajorDiameterMm: 7.7,
      threadPitchMm: 4.7,
      collarDepthMm: 5.5,
    },
  },
  'male-luer-barb': {
    portType: 'luer-lock',
    boreMm: 1.6,
    spec: {
      ...LUER_TAPER,
      bossHeightMm: 3,
      threadMajorDiameterMm: 7.7,
      threadPitchMm: 4.7,
      collarDepthMm: 5.5,
    },
  },
  'female-luer-barb': {
    portType: 'luer-male',
    boreMm: 1.6,
    spec: { ...LUER_TAPER, bossHeightMm: 2 },
  },
  barb: {
    portType: 'barb',
    boreMm: 1.6,
    spec: {
      barbCrestDiameterMm: 3.5,
      stemDiameterMm: 2.9,
      barbCount: 3,
      barbLengthMm: 10.5,
      bossHeightMm: 2,
    },
  },
  'tubing-socket': {
    portType: 'custom',
    boreMm: 1.6,
    spec: { outerDiameterMm: 4.7, depthMm: 8, bossHeightMm: 5 },
  },
  syringe: {
    portType: 'syringe',
    boreMm: 1.2,
    spec: { barrelDiameterMm: 1.6, barrelDepthMm: 6, bossHeightMm: 2 },
  },
};

// --- fluids ---------------------------------------------------------------
// Glycerol blends are computed with the app's own correlations rather than
// transcribed, so the numbers cannot drift out of step with it.

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const round = (v, places) => {
  const f = 10 ** places;
  return Math.round(v * f) / f;
};

const waterDensity = (t) =>
  1000 * (1 - ((t + 288.9414) / (508929.2 * (t + 68.12963))) * (t - 3.9863) ** 2);

function glycerolWaterViscosity(massFraction, T) {
  const Cm = clamp01(massFraction);
  const muWater = 1.79 * Math.exp(((-1230 - T) * T) / (36100 + 360 * T));
  const muGlycerol = 12100 * Math.exp(((-1233 + T) * T) / (9900 + 70 * T));
  const a = 0.705 - 0.0017 * T;
  const b = (4.9 + 0.036 * T) * Math.pow(a, 2.5);
  const denominator = a * Cm + b * (1 - Cm);
  const alpha = denominator === 0 ? 1 - Cm : 1 - Cm + (a * b * Cm * (1 - Cm)) / denominator;
  return (Math.pow(muWater, alpha) * Math.pow(muGlycerol, 1 - alpha)) / 1000;
}

function glycerolWaterProfile(volumePercent, temperatureC, id, name) {
  const rhoGlycerol = 1277 - 0.654 * temperatureC;
  const rhoWater = waterDensity(temperatureC);
  const v = clamp01(volumePercent / 100);
  const Cm = (v * rhoGlycerol) / (v * rhoGlycerol + (1 - v) * rhoWater);
  const density = 1 / (Cm / rhoGlycerol + (1 - Cm) / rhoWater);
  return {
    id,
    name,
    builtIn: true,
    densityKgM3: round(density, 1),
    dynamicViscosityPaS: round(glycerolWaterViscosity(Cm, temperatureC), 8),
    thermalConductivityWmK: round(0.598 * (1 - Cm) + 0.285 * Cm, 4),
    specificHeatCapacityJkgK: round(4182 * (1 - Cm) + 2430 * Cm, 0),
    inletTemperatureC: temperatureC,
    glycerolVolumePercent: volumePercent,
  };
}

export const FLUID_PRESETS = [
  {
    id: 'preset-water',
    name: 'Water',
    builtIn: true,
    densityKgM3: 998.2,
    dynamicViscosityPaS: 0.001002,
    thermalConductivityWmK: 0.598,
    specificHeatCapacityJkgK: 4182,
    inletTemperatureC: 20,
  },
  {
    id: 'preset-pbs',
    name: 'PBS buffer (1×)',
    builtIn: true,
    densityKgM3: 1005,
    dynamicViscosityPaS: 0.00102,
    thermalConductivityWmK: 0.6,
    specificHeatCapacityJkgK: 4100,
    inletTemperatureC: 20,
    note: 'Close to water; the dissolved salts change density more than viscosity.',
  },
  {
    id: 'preset-ethanol',
    name: 'Ethanol',
    builtIn: true,
    densityKgM3: 789,
    dynamicViscosityPaS: 0.0012,
    thermalConductivityWmK: 0.171,
    specificHeatCapacityJkgK: 2440,
    inletTemperatureC: 20,
  },
  {
    id: 'preset-mineral-oil',
    name: 'Mineral oil (light)',
    builtIn: true,
    densityKgM3: 850,
    dynamicViscosityPaS: 0.03,
    thermalConductivityWmK: 0.14,
    specificHeatCapacityJkgK: 1900,
    inletTemperatureC: 20,
    note: 'Grade-dependent: light oils run ~15–40 mPa·s, heavy ones far more. Check your bottle.',
  },
  {
    ...glycerolWaterProfile(50, 20, 'preset-glycerol-water', 'Glycerol/water 50%'),
    note: 'Adjust the glycerol percentage to tune viscosity — the relationship is strongly non-linear.',
  },
  {
    ...glycerolWaterProfile(40, 20, 'preset-blood-analog', 'Blood-mimicking analog'),
    nonNewtonianNote:
      'Whole blood is shear-thinning: its apparent viscosity falls from ~10 mPa·s at low shear to ~3.5 mPa·s above roughly 100 s⁻¹. ' +
      'This analog is a Newtonian glycerol/water blend matched to that high-shear value, which is the right regime for most microchannels. ' +
      'At very low shear rates it will under-predict the real thing.',
  },
];

/** DSL fluid words → preset ids. */
export const FLUID_ALIASES = {
  water: 'preset-water',
  pbs: 'preset-pbs',
  buffer: 'preset-pbs',
  ethanol: 'preset-ethanol',
  oil: 'preset-mineral-oil',
  'mineral-oil': 'preset-mineral-oil',
  glycerol: 'preset-glycerol-water',
  'glycerol-50': 'preset-glycerol-water',
  blood: 'preset-blood-analog',
  'blood-analog': 'preset-blood-analog',
};

export const DEFAULT_CHIP_PARAMS = {
  width: 40,
  length: 60,
  baseThickness: 4,
  wallThickness: 2,
  minEdgeSpacing: 3,
  splitType: 'two-piece',
  splitHeight: 2,
  slide: {
    widthMm: 75,
    lengthMm: 25,
    thicknessMm: 1,
    clearanceMm: 0.2,
    bondGapMm: 0,
    offsetXMm: 0,
    offsetYMm: 0,
  },
  defaultChannelWidthMm: 0.8,
  defaultChannelHeightMm: 0.5,
  defaultCrossSection: 'rect',
};

export const VALIDATION_SETTINGS = {
  taperRatioThreshold: 2,
  minPrintableWallMm: 0.4,
  overhangLimitDeg: 45,
};

const DEFAULT_VENT_DIAMETER_MM = 0.8;
const VENT_DISTANCE_THRESHOLD_MM = 15;

// ===========================================================================
// DSL parser
// ===========================================================================

class DslError extends Error {
  constructor(line, message) {
    super(`line ${line}: ${message}`);
    this.line = line;
  }
}

const CROSS_SECTIONS = new Set(['round', 'rect', 'trapezoid']);

/** `12,34` or `12, 34` → {x,y}. */
function parsePoint(text, lineNo) {
  const m = /^\(?\s*(-?[\d.]+)\s*,\s*(-?[\d.]+)\s*\)?$/.exec(text);
  if (!m) throw new DslError(lineNo, `expected a coordinate like 12,34 — got "${text}"`);
  return { x: Number(m[1]), y: Number(m[2]) };
}

/** `0.8` or `0.8x0.5` → {widthMm, heightMm?}. */
function parseSize(text, lineNo) {
  const m = /^(-?[\d.]+)(?:\s*[x×]\s*(-?[\d.]+))?$/.exec(text);
  if (!m) throw new DslError(lineNo, `expected a size like 0.8 or 0.8x0.5 — got "${text}"`);
  const size = { widthMm: Number(m[1]) };
  if (m[2] !== undefined) size.heightMm = Number(m[2]);
  return size;
}

/**
 * Splits a line into tokens, keeping `(x, y)` and "quoted text" whole.
 */
function tokenize(line) {
  const tokens = [];
  let i = 0;
  while (i < line.length) {
    const ch = line[i];
    if (/\s/.test(ch)) {
      i += 1;
      continue;
    }
    if (ch === '"') {
      const end = line.indexOf('"', i + 1);
      if (end === -1) {
        tokens.push(line.slice(i + 1));
        break;
      }
      tokens.push(line.slice(i + 1, end));
      i = end + 1;
      continue;
    }
    if (ch === '(') {
      const end = line.indexOf(')', i);
      if (end === -1) {
        tokens.push(line.slice(i));
        break;
      }
      tokens.push(line.slice(i, end + 1).replace(/\s+/g, ''));
      i = end + 1;
      continue;
    }
    let j = i;
    while (j < line.length && !/[\s("]/.test(line[j])) j += 1;
    // `name(1,2)` is one token, not two.
    if (line[j] === '(') {
      const end = line.indexOf(')', j);
      if (end !== -1) {
        tokens.push(line.slice(i, end + 1).replace(/\s+/g, ''));
        i = end + 1;
        continue;
      }
    }
    tokens.push(line.slice(i, j));
    i = j;
  }
  return tokens;
}

/**
 * Compiles Chip-DSL text into a complete `.openchip` project object.
 *
 * The grammar is documented in `references/DSL.md`; this is its only
 * implementation, so that file and this function must move together.
 */
export function compile(source, options = {}) {
  const lines = source.split(/\r?\n/);

  const state = {
    name: options.name ?? 'Untitled chip',
    printerKey: 'standard-4k',
    printer: null,
    chip: structuredClone(DEFAULT_CHIP_PARAMS),
    materialK: 0.2,
    nodes: new Map(),
    edges: [],
    vents: [],
    assignments: [],
    customFluids: [],
    presetRef: null,
    notes: [],
  };

  let edgeSeq = 0;
  let autoSeq = 0;
  const nextEdgeId = () => `e${++edgeSeq}`;

  /** An id for an anonymous waypoint that cannot collide with a declared one. */
  const nextWaypointId = () => {
    let id;
    do {
      id = `w${++autoSeq}`;
    } while (state.nodes.has(id));
    return id;
  };

  const declare = (node, lineNo) => {
    if (state.nodes.has(node.id)) {
      throw new DslError(lineNo, `node "${node.id}" is declared twice`);
    }
    state.nodes.set(node.id, node);
    return node.id;
  };

  /** Resolves a path reference: an id, `(x,y)`, or `id(x,y)`. */
  const resolveRef = (token, lineNo) => {
    if (token.startsWith('(')) {
      const point = parsePoint(token, lineNo);
      return declare({ id: nextWaypointId(), x: point.x, y: point.y, type: 'waypoint' }, lineNo);
    }
    const inline = /^([A-Za-z_][\w-]*)\((.+)\)$/.exec(token);
    if (inline) {
      const point = parsePoint(inline[2], lineNo);
      if (state.nodes.has(inline[1])) {
        throw new DslError(lineNo, `node "${inline[1]}" is declared twice`);
      }
      return declare({ id: inline[1], x: point.x, y: point.y, type: 'waypoint' }, lineNo);
    }
    if (!state.nodes.has(token)) {
      throw new DslError(lineNo, `unknown node "${token}" — declare it, or write it as id(x,y)`);
    }
    return token;
  };

  // A path spread over continuation lines needs its tail remembered.
  let lastPathTail = null;

  const readPath = (tokens, lineNo, startFrom) => {
    const refs = [];
    let i = 0;
    if (startFrom) refs.push(startFrom);

    // Chain: ref (-> ref)*
    while (i < tokens.length) {
      const token = tokens[i];
      if (token === '->') {
        i += 1;
        continue;
      }
      if (isModifier(token)) break;
      refs.push(resolveRef(token, lineNo));
      i += 1;
      if (tokens[i] !== '->') break;
    }

    if (refs.length < 2) {
      throw new DslError(lineNo, 'a path needs at least two points');
    }

    // Modifiers apply to every segment the line lays down.
    const mods = { crossSection: null, size: null, controlPoints: null, taper: null };
    while (i < tokens.length) {
      const token = tokens[i].toLowerCase();
      if (token === 'width') {
        mods.size = parseSize(tokens[i + 1], lineNo);
        i += 2;
      } else if (token === 'section') {
        const value = (tokens[i + 1] ?? '').toLowerCase();
        if (!CROSS_SECTIONS.has(value)) {
          throw new DslError(lineNo, `section must be round, rect or trapezoid — got "${value}"`);
        }
        mods.crossSection = value;
        i += 2;
      } else if (token === 'via') {
        const points = [];
        i += 1;
        while (i < tokens.length && tokens[i].startsWith('(')) {
          points.push(parsePoint(tokens[i], lineNo));
          i += 1;
        }
        if (points.length !== 2) {
          throw new DslError(lineNo, '`via` takes exactly two control points, e.g. via (9,33) (18,32)');
        }
        mods.controlPoints = points;
      } else if (token === 'taper') {
        const points = [];
        i += 1;
        while (i < tokens.length && /@/.test(tokens[i])) {
          const [sizeText, tText] = tokens[i].split('@');
          const size = parseSize(sizeText, lineNo);
          const t = Number(tText);
          if (!Number.isFinite(t) || t < 0 || t > 1) {
            throw new DslError(lineNo, `taper position must be between 0 and 1 — got "${tText}"`);
          }
          points.push({ t, ...size });
          i += 1;
        }
        if (points.length < 2) {
          throw new DslError(lineNo, '`taper` needs at least two markers, e.g. taper 0.6@0 0.35@1');
        }
        mods.taper = points;
      } else {
        throw new DslError(lineNo, `unexpected "${tokens[i]}" at the end of a path`);
      }
    }

    const segments = refs.length - 1;
    if (mods.controlPoints && segments !== 1) {
      throw new DslError(lineNo, '`via` only applies to a single-segment path');
    }
    if (mods.taper && segments !== 1) {
      throw new DslError(lineNo, '`taper` only applies to a single-segment path');
    }

    for (let s = 0; s < segments; s += 1) {
      const edge = {
        id: nextEdgeId(),
        fromNodeId: refs[s],
        toNodeId: refs[s + 1],
        curveType: mods.controlPoints ? 'bezier' : 'straight',
        crossSection: mods.crossSection ?? state.chip.defaultCrossSection,
        dimensionPoints: [],
      };
      if (mods.controlPoints) edge.controlPoints = mods.controlPoints;
      if (mods.taper) {
        edge.dimensionPoints = mods.taper;
      } else if (mods.size) {
        const height = mods.size.heightMm;
        const point = (t) => {
          const dp = { t, widthMm: mods.size.widthMm };
          if (height !== undefined) dp.heightMm = height;
          return dp;
        };
        edge.dimensionPoints = [point(0), point(1)];
      }
      state.edges.push(edge);
    }

    lastPathTail = refs[refs.length - 1];
  };

  // Two passes: declarations first, paths second. A path may then refer to a
  // node declared further down the file, which is how anyone writing one of
  // these by hand naturally works — you sketch the ports, then the routes.
  for (const phase of ['declare', 'path']) {
  for (let index = 0; index < lines.length; index += 1) {
    const lineNo = index + 1;
    const raw = lines[index].replace(/#.*$/, '').trim();
    if (!raw) continue;

    const tokens = tokenize(raw);
    const head = tokens[0].toLowerCase();

    const isPathLine = head === 'path' || head === '->';
    if (phase === 'declare' ? isPathLine : !isPathLine) continue;

    // A continuation line: `-> (7,43) -> (7,37)`.
    if (head === '->') {
      if (!lastPathTail) throw new DslError(lineNo, 'a continuation line has no path to continue');
      readPath(tokens.slice(1), lineNo, lastPathTail);
      continue;
    }

    switch (head) {
      case 'chip':
        state.name = tokens.slice(1).join(' ') || state.name;
        break;

      case 'from':
        // `from <preset-id>` — records provenance only.
        state.presetRef = tokens[1] ?? null;
        break;

      case 'printer': {
        const key = (tokens[1] ?? '').toLowerCase();
        if (PRINTERS[key]) {
          state.printerKey = key;
          state.printer = null;
        } else if (key === 'custom') {
          const spec = { ...PRINTERS['standard-4k'], name: 'My printer' };
          for (let i = 2; i < tokens.length; i += 1) {
            const [k, v] = tokens[i].split('=');
            if (k === 'name') spec.name = v;
            else if (k === 'xy') spec.xyResolutionMicrons = Number(v);
            else if (k === 'layer') spec.layerHeightMicrons = Number(v);
            else if (k === 'minfeature') spec.minFeatureSizeMm = Number(v);
            else if (k === 'volume') {
              const [x, y, z] = v.split(/[x×]/).map(Number);
              spec.buildVolumeMm = { x, y, z };
            } else throw new DslError(lineNo, `unknown printer field "${k}"`);
          }
          state.printer = spec;
        } else {
          throw new DslError(
            lineNo,
            `unknown printer "${tokens[1]}" — use ${Object.keys(PRINTERS).join(', ')} or custom`,
          );
        }
        break;
      }

      case 'size': {
        const dims = tokens.slice(1).join('').split(/[x×]/).map(Number);
        if (dims.length !== 2 || dims.some((d) => !Number.isFinite(d))) {
          throw new DslError(lineNo, 'size takes `<width> x <length>`, e.g. size 40 x 60');
        }
        state.chip.width = dims[0];
        state.chip.length = dims[1];
        break;
      }

      case 'base':
        state.chip.baseThickness = Number(tokens[1]);
        break;

      case 'wall':
        state.chip.wallThickness = Number(tokens[1]);
        break;

      case 'edge-spacing':
        state.chip.minEdgeSpacing = Number(tokens[1]);
        break;

      case 'material-k':
        state.materialK = Number(tokens[1]);
        break;

      case 'split': {
        const kind = (tokens[1] ?? '').toLowerCase();
        if (!['two-piece', 'monolithic', 'glass-slide'].includes(kind)) {
          throw new DslError(lineNo, 'split must be two-piece, monolithic or glass-slide');
        }
        state.chip.splitType = kind;
        const atIndex = tokens.findIndex((t) => t.toLowerCase() === 'at');
        if (atIndex !== -1) state.chip.splitHeight = Number(tokens[atIndex + 1]);
        break;
      }

      case 'slide': {
        const slide = state.chip.slide;
        const dims = (tokens[1] ?? '').split(/[x×]/);
        if (dims.length === 2) {
          slide.widthMm = Number(dims[0]);
          slide.lengthMm = Number(dims[1]);
        }
        for (let i = 1; i < tokens.length; i += 1) {
          const key = tokens[i].toLowerCase();
          if (key === 'thick') slide.thicknessMm = Number(tokens[++i]);
          else if (key === 'clearance') slide.clearanceMm = Number(tokens[++i]);
          else if (key === 'gap') slide.bondGapMm = Number(tokens[++i]);
          else if (key === 'offset') {
            const point = parsePoint(tokens[++i], lineNo);
            slide.offsetXMm = point.x;
            slide.offsetYMm = point.y;
          }
        }
        break;
      }

      case 'channel': {
        // `channel 0.8 x 0.5 rect`, or `channel 0.8x0.5 round`
        const joined = tokens.slice(1).filter((t) => !CROSS_SECTIONS.has(t.toLowerCase()));
        const size = parseSize(joined.join('').replace(/^x/, ''), lineNo);
        state.chip.defaultChannelWidthMm = size.widthMm;
        if (size.heightMm !== undefined) state.chip.defaultChannelHeightMm = size.heightMm;
        const section = tokens.slice(1).find((t) => CROSS_SECTIONS.has(t.toLowerCase()));
        if (section) state.chip.defaultCrossSection = section.toLowerCase();
        break;
      }

      case 'node': {
        const id = tokens[1];
        const atIndex = tokens.findIndex((t) => t.toLowerCase() === 'at');
        const point = parsePoint(tokens[atIndex + 1], lineNo);
        declare({ id, x: point.x, y: point.y, type: 'waypoint' }, lineNo);
        break;
      }

      case 'chamber': {
        const id = tokens[1];
        const atIndex = tokens.findIndex((t) => t.toLowerCase() === 'at');
        const point = parsePoint(tokens[atIndex + 1], lineNo);
        const rest = tokens.slice(atIndex + 2);
        const shape = rest.find((t) => t === 'sphere' || t === 'cylinder') ?? 'sphere';
        const sizeToken = rest.find((t) => Number.isFinite(Number(t)));
        if (sizeToken === undefined) {
          throw new DslError(lineNo, 'a chamber needs a size, e.g. chamber c1 at 20,30 sphere 3');
        }
        declare(
          {
            id,
            x: point.x,
            y: point.y,
            type: 'chamber',
            shape,
            sizeMm: Number(sizeToken),
            autoPlaced: false,
          },
          lineNo,
        );
        break;
      }

      case 'port': {
        const id = tokens[1];
        const atIndex = tokens.findIndex((t) => t.toLowerCase() === 'at');
        if (atIndex === -1) throw new DslError(lineNo, 'a port needs `at <x>,<y>`');
        const point = parsePoint(tokens[atIndex + 1], lineNo);

        let fittingKey = 'luer-slip';
        let bore = null;
        let role = null;
        let fluid = null;
        let flow = null;
        let temperature = null;

        for (let i = atIndex + 2; i < tokens.length; i += 1) {
          const token = tokens[i].toLowerCase();
          if (FITTINGS[token]) {
            fittingKey = token;
          } else if (token === 'bore') {
            bore = Number(tokens[++i]);
          } else if (token === 'inlet') {
            role = 'inlet';
            const fluidToken = (tokens[i + 1] ?? '').toLowerCase();
            if (FLUID_ALIASES[fluidToken]) {
              fluid = FLUID_ALIASES[fluidToken];
              i += 1;
            }
            const flowToken = tokens[i + 1];
            if (flowToken !== undefined && Number.isFinite(Number(flowToken))) {
              flow = Number(flowToken);
              i += 1;
            }
          } else if (token === 'outlet') {
            role = 'outlet';
          } else if (token === 'at') {
            // `at 60C` — an inlet temperature override.
            const value = Number((tokens[i + 1] ?? '').replace(/c$/i, ''));
            if (Number.isFinite(value)) {
              temperature = value;
              i += 1;
            }
          } else {
            throw new DslError(lineNo, `unexpected "${tokens[i]}" on a port`);
          }
        }

        const fitting = FITTINGS[fittingKey];
        declare(
          {
            id,
            x: point.x,
            y: point.y,
            type: 'port',
            portType: fitting.portType,
            diameterMm: bore ?? fitting.boreMm,
            customSpec: { ...fitting.spec },
          },
          lineNo,
        );

        if (role) {
          state.assignments.push({
            portId: id,
            role,
            fluidProfileId: fluid ?? 'preset-water',
            flowRateUlPerMin: role === 'inlet' ? (flow ?? 10) : 0,
            inletTemperatureC: temperature,
          });
        }
        break;
      }

      case 'vent': {
        const nodeId = tokens[1];
        const diameter = tokens[2] !== undefined ? Number(tokens[2]) : DEFAULT_VENT_DIAMETER_MM;
        state.vents.push({ nodeId, diameterMm: diameter });
        break;
      }

      case 'fluid': {
        // `fluid my-oil density 900 viscosity 0.02 k 0.14 cp 1900 temp 20`
        const profile = {
          id: tokens[1],
          name: tokens[1],
          builtIn: false,
          densityKgM3: 998.2,
          dynamicViscosityPaS: 0.001002,
          thermalConductivityWmK: 0.598,
          specificHeatCapacityJkgK: 4182,
          inletTemperatureC: 20,
        };
        for (let i = 2; i < tokens.length; i += 1) {
          const key = tokens[i].toLowerCase();
          if (key === 'name') profile.name = tokens[++i];
          else if (key === 'density') profile.densityKgM3 = Number(tokens[++i]);
          else if (key === 'viscosity') profile.dynamicViscosityPaS = Number(tokens[++i]);
          else if (key === 'k') profile.thermalConductivityWmK = Number(tokens[++i]);
          else if (key === 'cp') profile.specificHeatCapacityJkgK = Number(tokens[++i]);
          else if (key === 'temp') profile.inletTemperatureC = Number(tokens[++i]);
          else throw new DslError(lineNo, `unknown fluid field "${tokens[i]}"`);
        }
        state.customFluids.push(profile);
        FLUID_ALIASES[profile.id.toLowerCase()] = profile.id;
        break;
      }

      case 'note':
        state.notes.push(tokens.slice(1).join(' '));
        break;

      case 'path':
        readPath(tokens.slice(1), lineNo, null);
        break;

      default:
        throw new DslError(lineNo, `unknown statement "${tokens[0]}"`);
    }
  }
  }

  // --- assemble -----------------------------------------------------------

  const now = options.now ?? new Date().toISOString();
  const printerProfile = state.printer ?? PRINTERS[state.printerKey];

  const vents = state.vents.map((vent, i) => ({
    id: `vent-${i + 1}`,
    nodeId: vent.nodeId,
    diameterMm: vent.diameterMm,
    autoPlaced: false,
  }));

  return {
    formatVersion: 1,
    meta: { name: state.name, createdAt: now, modifiedAt: now, units: 'mm' },
    printerProfile: structuredClone(printerProfile),
    chipParams: state.chip,
    channelGraph: { nodes: [...state.nodes.values()], edges: state.edges },
    fluidProfiles: [...FLUID_PRESETS.map((f) => ({ ...f })), ...state.customFluids],
    fluidSetup: {
      assignments: state.assignments,
      chipMaterialThermalConductivityWmK: state.materialK,
    },
    savedImages: [],
    drainageVents: vents,
    presetLibraryRef: state.presetRef,
  };
}

const isModifier = (token) =>
  ['width', 'section', 'via', 'taper'].includes(String(token).toLowerCase());

// ===========================================================================
// geometry — the same arithmetic the app's loft solver uses
// ===========================================================================

const lerpPoint = (a, b, t) => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

function edgeCurve(edge, from, to) {
  if (edge.curveType === 'bezier' && edge.controlPoints && edge.controlPoints.length >= 2) {
    return { p0: from, c0: edge.controlPoints[0], c1: edge.controlPoints[1], p1: to };
  }
  return { p0: from, c0: lerpPoint(from, to, 1 / 3), c1: lerpPoint(from, to, 2 / 3), p1: to };
}

function cubicAt(curve, t) {
  const u = 1 - t;
  const a = u * u * u;
  const b = 3 * u * u * t;
  const c = 3 * u * t * t;
  const d = t * t * t;
  return {
    x: a * curve.p0.x + b * curve.c0.x + c * curve.c1.x + d * curve.p1.x,
    y: a * curve.p0.y + b * curve.c0.y + c * curve.c1.y + d * curve.p1.y,
  };
}

function cubicLength(curve, steps = 32) {
  let total = 0;
  let previous = cubicAt(curve, 0);
  for (let i = 1; i <= steps; i += 1) {
    const point = cubicAt(curve, i / steps);
    total += dist(previous, point);
    previous = point;
  }
  return total;
}

function buildAdjacency(edges) {
  const adjacency = new Map();
  const push = (id, edge) => {
    const list = adjacency.get(id);
    if (list) list.push(edge);
    else adjacency.set(id, [edge]);
  };
  for (const edge of edges) {
    push(edge.fromNodeId, edge);
    push(edge.toNodeId, edge);
  }
  return adjacency;
}

/** Maximal runs of edges joined end-to-end through degree-2 nodes. */
function buildChains(graph) {
  const nodes = new Map(graph.nodes.map((n) => [n.id, n]));
  const adjacency = buildAdjacency(graph.edges);
  const visited = new Set();
  const chains = [];
  const otherEnd = (edge, nodeId) => (edge.fromNodeId === nodeId ? edge.toNodeId : edge.fromNodeId);
  const isPassThrough = (nodeId) => (adjacency.get(nodeId)?.length ?? 0) === 2;

  const walk = (startEdge, startNode) => {
    const run = [];
    let currentEdge = startEdge;
    let currentNode = startNode;
    for (;;) {
      if (!isPassThrough(currentNode)) break;
      const next = (adjacency.get(currentNode) ?? []).find((e) => e.id !== currentEdge.id);
      if (!next || visited.has(next.id)) break;
      visited.add(next.id);
      run.push(next);
      currentNode = otherEnd(next, currentNode);
      currentEdge = next;
    }
    return run;
  };

  for (const seed of graph.edges) {
    if (visited.has(seed.id)) continue;
    visited.add(seed.id);
    const ordered = [...walk(seed, seed.fromNodeId).reverse(), seed, ...walk(seed, seed.toNodeId)];

    const members = [];
    let cursor = 0;
    let joint = null;

    for (let i = 0; i < ordered.length; i += 1) {
      const edge = ordered[i];
      const from = nodes.get(edge.fromNodeId);
      const to = nodes.get(edge.toNodeId);
      if (!from || !to) continue;

      let reversed = false;
      if (joint === null) {
        const next = ordered[i + 1];
        if (next) reversed = edge.fromNodeId === next.fromNodeId || edge.fromNodeId === next.toNodeId;
      } else {
        reversed = edge.toNodeId === joint;
      }

      const curve = edgeCurve(edge, from, to);
      const lengthMm = cubicLength(curve);
      members.push({ edge, curve, reversed, startDistance: cursor, lengthMm });
      cursor += lengthMm;
      joint = reversed ? edge.fromNodeId : edge.toNodeId;
    }

    if (members.length > 0) chains.push({ members, totalLengthMm: cursor });
  }

  return chains;
}

function chainMarkers(chain) {
  const markers = [];
  for (const member of chain.members) {
    for (const dp of member.edge.dimensionPoints ?? []) {
      const local = member.reversed ? 1 - dp.t : dp.t;
      markers.push({
        distanceMm: member.startDistance + local * member.lengthMm,
        widthMm: dp.widthMm,
        heightMm: dp.heightMm,
        edgeId: member.edge.id,
        t: dp.t,
      });
    }
  }
  return markers.sort((a, b) => a.distanceMm - b.distanceMm);
}

function sizeAtDistance(markers, distanceMm, fallback) {
  if (markers.length === 0) return fallback;
  const first = markers[0];
  if (distanceMm <= first.distanceMm) {
    return { widthMm: first.widthMm, heightMm: first.heightMm ?? fallback.heightMm };
  }
  const last = markers[markers.length - 1];
  if (distanceMm >= last.distanceMm) {
    return { widthMm: last.widthMm, heightMm: last.heightMm ?? fallback.heightMm };
  }
  for (let i = 1; i < markers.length; i += 1) {
    const a = markers[i - 1];
    const b = markers[i];
    if (distanceMm > b.distanceMm) continue;
    const span = b.distanceMm - a.distanceMm;
    const t = span < 1e-9 ? 0 : (distanceMm - a.distanceMm) / span;
    return {
      widthMm: a.widthMm + (b.widthMm - a.widthMm) * t,
      heightMm:
        (a.heightMm ?? fallback.heightMm) +
        ((b.heightMm ?? fallback.heightMm) - (a.heightMm ?? fallback.heightMm)) * t,
    };
  }
  return fallback;
}

/** Per-edge samples of centreline point and local channel size. */
function solveLoft(graph, chipParams, steps = 24) {
  const fallback = {
    widthMm: chipParams.defaultChannelWidthMm,
    heightMm: chipParams.defaultChannelHeightMm,
  };
  const edges = new Map();

  for (const chain of buildChains(graph)) {
    const markers = chainMarkers(chain);
    for (const member of chain.members) {
      const samples = [];
      for (let i = 0; i <= steps; i += 1) {
        const t = i / steps;
        const local = member.reversed ? 1 - t : t;
        const distanceMm = member.startDistance + local * member.lengthMm;
        const size = sizeAtDistance(markers, distanceMm, fallback);
        samples.push({ point: cubicAt(member.curve, t), ...size });
      }
      edges.set(member.edge.id, { samples, lengthMm: member.lengthMm });
    }
  }

  return { edges };
}

function portFootprintMm(portType, spec = {}) {
  const read = (key) => {
    const value = spec[key];
    return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
  };
  switch (portType) {
    case 'luer-lock':
      return read('threadMajorDiameterMm') ?? read('taperLargeDiameterMm') ?? 7.6;
    case 'luer':
    case 'luer-male':
      return read('taperLargeDiameterMm') ?? 4.27;
    case 'barb':
      return read('barbCrestDiameterMm') ?? 3.5;
    case 'syringe':
      return read('barrelDiameterMm') ?? 1.6;
    default:
      return read('outerDiameterMm') ?? 4;
  }
}

const nodeFootprintMm = (node, chipParams) => {
  if (node.type === 'port') return portFootprintMm(node.portType, node.customSpec);
  if (node.type === 'chamber') return node.sizeMm;
  return chipParams.defaultChannelWidthMm;
};

// ===========================================================================
// checks
// ===========================================================================

const mm = (n) => Math.round(n * 1000) / 1000;

const warn = (severity, kind, title, detail) => ({ severity, kind, title, detail });

/** Structural problems that would stop the file opening at all. */
export function checkStructure(project) {
  const problems = [];
  const graph = project.channelGraph;
  const ids = new Set();

  for (const node of graph.nodes) {
    if (ids.has(node.id)) problems.push(`Two nodes share the id "${node.id}".`);
    ids.add(node.id);
    if (!Number.isFinite(node.x) || !Number.isFinite(node.y)) {
      problems.push(`Node "${node.id}" has a non-numeric position.`);
    }
    if (node.type === 'port' && !(node.diameterMm > 0)) {
      problems.push(`Port "${node.id}" has no positive bore diameter.`);
    }
    if (node.type === 'chamber' && !(node.sizeMm > 0)) {
      problems.push(`Chamber "${node.id}" has no positive size.`);
    }
  }

  const edgeIds = new Set();
  for (const edge of graph.edges) {
    if (edgeIds.has(edge.id)) problems.push(`Two channel segments share the id "${edge.id}".`);
    edgeIds.add(edge.id);
    if (!ids.has(edge.fromNodeId)) {
      problems.push(`Segment "${edge.id}" starts at node "${edge.fromNodeId}", which is missing.`);
    }
    if (!ids.has(edge.toNodeId)) {
      problems.push(`Segment "${edge.id}" ends at node "${edge.toNodeId}", which is missing.`);
    }
    if (edge.fromNodeId === edge.toNodeId) {
      problems.push(`Segment "${edge.id}" starts and ends at the same node.`);
    }
    for (const dp of edge.dimensionPoints ?? []) {
      if (!(dp.t >= 0 && dp.t <= 1)) {
        problems.push(`Segment "${edge.id}" has a dimension marker at t=${dp.t}, outside 0–1.`);
      }
      if (!(dp.widthMm > 0)) {
        problems.push(`Segment "${edge.id}" has a dimension marker with no positive width.`);
      }
    }
  }

  for (const vent of project.drainageVents ?? []) {
    if (!ids.has(vent.nodeId)) {
      problems.push(`Drainage vent "${vent.id}" is anchored to missing node "${vent.nodeId}".`);
    }
  }
  for (const assignment of project.fluidSetup?.assignments ?? []) {
    const node = graph.nodes.find((n) => n.id === assignment.portId);
    if (!node) {
      problems.push(`Fluid assignment references missing port "${assignment.portId}".`);
    } else if (node.type !== 'port') {
      problems.push(`Fluid assignment targets "${assignment.portId}", which is not a port.`);
    }
    if (
      assignment.fluidProfileId !== null &&
      !(project.fluidProfiles ?? []).some((f) => f.id === assignment.fluidProfileId)
    ) {
      problems.push(`Fluid assignment references unknown fluid "${assignment.fluidProfileId}".`);
    }
  }

  return problems;
}

/**
 * Authoring mistakes the app has no opinion about.
 *
 * These are not OpenChip checks and are reported separately so nobody mistakes
 * them for one. They exist because the two cheapest ways to build a broken
 * graph both produce a *structurally valid* file: writing `(20,47)` twice when
 * you meant to reuse one point lays down two nodes on top of each other, and a
 * declared node no path ever mentions is simply invisible. Both surface much
 * later as a puzzling `dead-end-channel` several inferences from the cause.
 */
export function lint(project) {
  const graph = project.channelGraph;
  const notes = [];
  const used = new Set();
  for (const edge of graph.edges) {
    used.add(edge.fromNodeId);
    used.add(edge.toNodeId);
  }

  const byPosition = new Map();
  for (const node of graph.nodes) {
    const key = `${Math.round(node.x * 1000)},${Math.round(node.y * 1000)}`;
    const list = byPosition.get(key);
    if (list) list.push(node);
    else byPosition.set(key, [node]);
  }
  for (const [, group] of byPosition) {
    if (group.length < 2) continue;
    const ids = group.map((n) => `"${n.id}"`).join(', ');
    notes.push(
      `${group.length} separate nodes sit at (${group[0].x}, ${group[0].y}): ${ids}. ` +
        'Coordinates never join anything — two points at the same place are still two ' +
        'nodes with no channel between them. Name the node and refer to it by id.',
    );
  }

  for (const node of graph.nodes) {
    if (used.has(node.id)) continue;
    notes.push(`Node "${node.id}" is not on any channel segment — nothing connects to it.`);
  }

  return notes;
}

export function runChecks(project) {
  const graph = project.channelGraph;
  const chipParams = project.chipParams;
  const printerProfile = project.printerProfile;
  const settings = VALIDATION_SETTINGS;
  const warnings = [];

  // --- build volume -------------------------------------------------------
  const build = printerProfile.buildVolumeMm;
  const fits =
    (chipParams.width <= build.x && chipParams.length <= build.y) ||
    (chipParams.length <= build.x && chipParams.width <= build.y);
  if (!fits) {
    warnings.push(
      warn(
        'risk',
        'footprint-exceeds-build-volume',
        'Chip footprint is larger than the build plate',
        `The chip is ${chipParams.width} × ${chipParams.length} mm and ${printerProfile.name} has a ${build.x} × ${build.y} mm plate, in either orientation.`,
      ),
    );
  }
  const tallest =
    chipParams.splitType === 'two-piece'
      ? Math.max(chipParams.splitHeight, chipParams.baseThickness - chipParams.splitHeight)
      : chipParams.baseThickness;
  if (tallest > build.z) {
    warnings.push(
      warn(
        'risk',
        'footprint-exceeds-build-volume',
        'Chip is taller than the printer can build',
        `The tallest piece is ${mm(tallest)} mm and the machine tops out at ${build.z} mm.`,
      ),
    );
  }

  if (graph.nodes.length === 0 && graph.edges.length === 0) return warnings;

  const loft = solveLoft(graph, chipParams);

  // --- minimum feature ----------------------------------------------------
  const narrow = [];
  for (const edge of graph.edges) {
    const solved = loft.edges.get(edge.id);
    if (!solved) continue;
    let narrowest = Infinity;
    let where = null;
    let at = 0;
    for (let i = 0; i < solved.samples.length; i += 1) {
      const sample = solved.samples[i];
      const smallest =
        edge.crossSection === 'round' ? sample.widthMm : Math.min(sample.widthMm, sample.heightMm);
      if (smallest < narrowest) {
        narrowest = smallest;
        where = sample.point;
        at = i / (solved.samples.length - 1);
      }
    }
    if (narrowest < printerProfile.minFeatureSizeMm) narrow.push({ edge, narrowest, where, at });
  }
  if (narrow.length > 0) {
    const worst = narrow.reduce((a, b) => (b.narrowest < a.narrowest ? b : a));
    // Name the spot, not just the segment: on a lofted taper the offending
    // point is usually nowhere near either end, and "segment e4" alone sends
    // you hunting along the whole chain for it.
    const at = `"${worst.edge.id}" at t=${mm(worst.at)} (${mm(worst.where.x)}, ${mm(worst.where.y)})`;
    warnings.push(
      warn(
        'risk',
        'channel-below-min-feature',
        narrow.length === 1
          ? `Channel narrows to ${mm(worst.narrowest)} mm`
          : `${narrow.length} segments drop to ${mm(worst.narrowest)} mm or less`,
        `${printerProfile.name} resolves about ${printerProfile.minFeatureSizeMm} mm. Below that the channel is likely to cure closed. Narrowest point is on ${at}. Widen it, or pick a finer printer profile.`,
      ),
    );
  }

  // --- boundary clearance -------------------------------------------------
  for (const node of graph.nodes) {
    const radius = nodeFootprintMm(node, chipParams) / 2;
    const clearance = Math.min(
      node.x - radius,
      chipParams.width - (node.x + radius),
      node.y - radius,
      chipParams.length - (node.y + radius),
    );
    if (clearance >= chipParams.minEdgeSpacing) continue;
    const outside = clearance < 0;
    warnings.push(
      warn(
        outside ? 'risk' : 'caution',
        'channel-near-boundary',
        outside
          ? `"${node.id}" sits ${mm(Math.abs(clearance))} mm outside the chip`
          : `"${node.id}" is ${mm(clearance)} mm from the chip edge`,
        outside
          ? 'It falls beyond the chip outline, so it will be cut off entirely. Move it inward or enlarge the chip.'
          : `Minimum edge spacing is ${chipParams.minEdgeSpacing} mm; a port is measured on its boss (${mm(nodeFootprintMm(node, chipParams))} mm across), not its bore.`,
      ),
    );
  }
  for (const edge of graph.edges) {
    const solved = loft.edges.get(edge.id);
    if (!solved) continue;
    let worst = Infinity;
    let where = null;
    for (const sample of solved.samples) {
      const half = sample.widthMm / 2;
      const clearance = Math.min(
        sample.point.x - half,
        chipParams.width - (sample.point.x + half),
        sample.point.y - half,
        chipParams.length - (sample.point.y + half),
      );
      if (clearance < worst) {
        worst = clearance;
        where = sample.point;
      }
    }
    if (worst >= chipParams.minEdgeSpacing || !where) continue;
    const from = graph.nodes.find((n) => n.id === edge.fromNodeId);
    const to = graph.nodes.find((n) => n.id === edge.toNodeId);
    if ((from && dist(where, from) < 1) || (to && dist(where, to) < 1)) continue;
    warnings.push(
      warn(
        worst < 0 ? 'risk' : 'caution',
        'channel-near-boundary',
        worst < 0
          ? `Segment "${edge.id}" runs outside the chip outline`
          : `Segment "${edge.id}" passes ${mm(worst)} mm from the chip edge`,
        `Minimum edge spacing is ${chipParams.minEdgeSpacing} mm.`,
      ),
    );
  }

  // --- wall between channels ---------------------------------------------
  const limit = Math.max(chipParams.wallThickness, settings.minPrintableWallMm);
  for (let i = 0; i < graph.edges.length; i += 1) {
    for (let j = i + 1; j < graph.edges.length; j += 1) {
      const a = graph.edges[i];
      const b = graph.edges[j];
      const shareNode =
        a.fromNodeId === b.fromNodeId ||
        a.fromNodeId === b.toNodeId ||
        a.toNodeId === b.fromNodeId ||
        a.toNodeId === b.toNodeId;
      if (shareNode) continue;
      const sa = loft.edges.get(a.id);
      const sb = loft.edges.get(b.id);
      if (!sa || !sb) continue;

      let worstGap = Infinity;
      for (const pa of sa.samples) {
        for (const pb of sb.samples) {
          const gap = dist(pa.point, pb.point) - pa.widthMm / 2 - pb.widthMm / 2;
          if (gap < worstGap) worstGap = gap;
        }
      }
      if (worstGap >= limit) continue;
      const overlapping = worstGap < 0;
      warnings.push(
        warn(
          overlapping ? 'risk' : 'caution',
          overlapping ? 'channels-overlap' : 'channels-too-close',
          overlapping
            ? `Segments "${a.id}" and "${b.id}" overlap`
            : `Only ${mm(worstGap)} mm of wall between "${a.id}" and "${b.id}"`,
          overlapping
            ? 'They intersect, so they will print as one merged cavity. If they are meant to join, connect them at a shared node instead.'
            : `Wall thickness is ${chipParams.wallThickness} mm and ${settings.minPrintableWallMm} mm is about the practical floor for resin.`,
        ),
      );
    }
  }

  // --- ports --------------------------------------------------------------
  for (const node of graph.nodes) {
    if (node.type !== 'port') continue;
    const spec = (key, fallback) => {
      const value = node.customSpec?.[key];
      return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback;
    };

    let wide = null;
    let narrowD = null;
    let depth = null;
    if (node.portType === 'luer' || node.portType === 'luer-lock') {
      wide = spec('taperLargeDiameterMm', LUER_TAPER.taperLargeDiameterMm);
      narrowD = spec('taperSmallDiameterMm', LUER_TAPER.taperSmallDiameterMm);
      depth = spec('taperLengthMm', LUER_TAPER.taperLengthMm);
    } else if (node.portType === 'custom') {
      wide = spec('outerDiameterMm', 4);
      narrowD = node.diameterMm;
      depth = spec('depthMm', 5);
    }
    if (wide !== null && depth > 0) {
      const angle = (Math.atan(Math.abs(wide - narrowD) / 2 / depth) * 180) / Math.PI;
      if (angle > settings.overhangLimitDeg) {
        warnings.push(
          warn(
            'caution',
            'port-overhang',
            `Port "${node.id}" flares at ${Math.round(angle)}° from vertical`,
            `Past about ${settings.overhangLimitDeg}° the roof of the socket is unsupported. Deepen the socket or reduce the diameter change.`,
          ),
        );
      }
    }

    if (node.portType === 'luer-male' || node.portType === 'barb') {
      const narrowest =
        node.portType === 'luer-male'
          ? spec('taperSmallDiameterMm', LUER_TAPER.taperSmallDiameterMm)
          : spec('stemDiameterMm', 2.9);
      const wall = (narrowest - node.diameterMm) / 2;
      if (wall < settings.minPrintableWallMm * 2) {
        const tooThin = wall < settings.minPrintableWallMm;
        warnings.push(
          warn(
            tooThin ? 'risk' : 'caution',
            'port-protrusion',
            `Fitting "${node.id}" has ${wall.toFixed(2)} mm of wall at its thinnest`,
            'This fitting stands proud of the chip with nothing bracing it. Narrow the bore or widen the fitting to gain wall.',
          ),
        );
      }
    }

    if (node.portType === 'luer-lock') {
      warnings.push(
        warn(
          'info',
          'thread-support',
          `Luer-lock thread on "${node.id}" may need orientation care`,
          'The thread is a helical rib, unsupported on its underside. Print the chip flat and expect to test-fit.',
        ),
      );
    }
  }

  // --- flow feasibility ---------------------------------------------------
  const adjacency = buildAdjacency(graph.edges);
  for (const node of graph.nodes) {
    if (node.type === 'port') continue;
    if ((adjacency.get(node.id)?.length ?? 0) !== 1) continue;
    warnings.push(
      warn(
        'caution',
        'dead-end-channel',
        `"${node.id}" ends without a port`,
        'This branch stops mid-chip. It will trap air when priming and uncured resin when printing. Add a port here, or delete the branch.',
      ),
    );
  }

  const components = connectedComponents(graph).filter((c) => c.edgeIds.length > 0);
  const totalPorts = graph.nodes.filter((n) => n.type === 'port').length;
  if (totalPorts === 0) {
    warnings.push(
      warn(
        'risk',
        'no-ports',
        'The chip has no ports',
        'There is no way to get fluid in or out, and no opening for resin to drain through.',
      ),
    );
  }
  if (components.length > 1) {
    warnings.push(
      warn(
        'caution',
        'disconnected-network',
        `The network is in ${components.length} separate pieces`,
        'Fine if deliberate; a break you did not intend will stop fluid reaching part of the chip.',
      ),
    );
  }
  if (totalPorts > 0) {
    for (const component of components) {
      if (component.portIds.length >= 2) continue;
      warnings.push(
        warn(
          component.portIds.length === 0 ? 'risk' : 'caution',
          component.portIds.length === 0 ? 'disconnected-network' : 'dead-end-channel',
          component.portIds.length === 0
            ? 'A section of the network has no port at all'
            : 'A section has only one port',
          component.portIds.length === 0
            ? 'Nothing connects this section to the outside, so it can never be filled or drained.'
            : 'With a single opening there is no through-path: fluid has nowhere to exit and resin cannot be flushed out.',
        ),
      );
    }
  }

  // --- taper --------------------------------------------------------------
  for (const chain of buildChains(graph)) {
    const markers = chainMarkers(chain);
    for (let i = 1; i < markers.length; i += 1) {
      const a = markers[i - 1];
      const b = markers[i];
      const larger = Math.max(a.widthMm, b.widthMm);
      const smaller = Math.min(a.widthMm, b.widthMm);
      if (smaller <= 0) continue;
      const ratio = larger / smaller;
      if (ratio < settings.taperRatioThreshold) continue;
      const spanMm = Math.abs(b.distanceMm - a.distanceMm);
      warnings.push(
        warn(
          ratio >= settings.taperRatioThreshold * 2 ? 'caution' : 'info',
          'abrupt-taper',
          `Channel width changes ${ratio.toFixed(1)}× over ${mm(spanMm)} mm`,
          `From ${mm(a.widthMm)} mm to ${mm(b.widthMm)} mm. Sharp expansions shed vortices and trap bubbles; sharp contractions raise pressure and shear. Threshold is ${settings.taperRatioThreshold}×.`,
        ),
      );
    }
  }

  // --- enclosure and drainage --------------------------------------------
  const enclosure = enclosureState(chipParams);
  if (enclosure.enclosed) {
    const vents = project.drainageVents ?? [];
    warnings.push(
      warn(
        vents.length > 0 ? 'info' : 'caution',
        'enclosed-cavity',
        vents.length > 0
          ? `Channels are sealed — ${vents.length} vent${vents.length === 1 ? '' : 's'} placed`
          : 'Channels are fully enclosed',
        `${enclosure.reason} Uncured resin sits inside after printing and will set solid unless it can be flushed out. ` +
          (vents.length > 0
            ? 'The vents give it a path out.'
            : 'Add drainage vents, or switch to a two-piece split so the channels are open until you bond the lid on.'),
      ),
    );

    for (const point of farthestFromOpening(graph)) {
      const vented = (project.drainageVents ?? []).some((v) => v.nodeId === point.nodeId);
      if (vented) continue;
      warnings.push(
        warn(
          'info',
          'undrained-region',
          `"${point.nodeId}" is ${mm(point.distanceMm)} mm of channel from the nearest opening`,
          'Resin here has the furthest to travel to escape. A vent at this node is where one does the most good.',
        ),
      );
    }
  }

  // --- glass slide --------------------------------------------------------
  if (chipParams.splitType === 'glass-slide') {
    warnings.push(...slideChecks(project, loft));
  }

  return warnings;
}

function connectedComponents(graph) {
  const adjacency = new Map();
  const push = (from, to, edgeId) => {
    const list = adjacency.get(from);
    const entry = { nodeId: to, edgeId };
    if (list) list.push(entry);
    else adjacency.set(from, [entry]);
  };
  for (const edge of graph.edges) {
    push(edge.fromNodeId, edge.toNodeId, edge.id);
    push(edge.toNodeId, edge.fromNodeId, edge.id);
  }

  const seen = new Set();
  const components = [];
  for (const node of graph.nodes) {
    if (seen.has(node.id)) continue;
    const nodeIds = [];
    const edgeIds = new Set();
    const portIds = [];
    const queue = [node.id];
    seen.add(node.id);
    while (queue.length > 0) {
      const current = queue.pop();
      nodeIds.push(current);
      const currentNode = graph.nodes.find((n) => n.id === current);
      if (currentNode?.type === 'port') portIds.push(current);
      for (const link of adjacency.get(current) ?? []) {
        edgeIds.add(link.edgeId);
        if (!seen.has(link.nodeId)) {
          seen.add(link.nodeId);
          queue.push(link.nodeId);
        }
      }
    }
    components.push({ nodeIds, edgeIds: [...edgeIds], portIds });
  }
  return components;
}

function enclosureState(chipParams) {
  if (chipParams.splitType === 'monolithic') {
    return {
      enclosed: true,
      reason: 'The chip is monolithic, so every channel is sealed inside the block.',
    };
  }
  if (chipParams.splitType === 'glass-slide') return { enclosed: false, reason: '' };
  if (chipParams.splitHeight <= 0 || chipParams.splitHeight >= chipParams.baseThickness) {
    return {
      enclosed: true,
      reason: `The split plane at ${chipParams.splitHeight} mm falls outside a ${chipParams.baseThickness} mm block, so no cut happens and the chip prints as a sealed solid.`,
    };
  }
  return { enclosed: false, reason: '' };
}

/** Nodes that are local maxima of along-channel distance to the nearest port. */
function farthestFromOpening(graph) {
  const ports = graph.nodes.filter((n) => n.type === 'port').map((n) => n.id);
  if (ports.length === 0) return [];

  const nodes = new Map(graph.nodes.map((n) => [n.id, n]));
  const neighbours = new Map();
  for (const edge of graph.edges) {
    const from = nodes.get(edge.fromNodeId);
    const to = nodes.get(edge.toNodeId);
    if (!from || !to) continue;
    const length = cubicLength(edgeCurve(edge, from, to));
    const push = (a, b) => {
      const list = neighbours.get(a);
      const entry = { nodeId: b, length };
      if (list) list.push(entry);
      else neighbours.set(a, [entry]);
    };
    push(edge.fromNodeId, edge.toNodeId);
    push(edge.toNodeId, edge.fromNodeId);
  }

  // Multi-source Dijkstra from every port.
  const distances = new Map(graph.nodes.map((n) => [n.id, Infinity]));
  for (const id of ports) distances.set(id, 0);
  const queue = [...ports];
  while (queue.length > 0) {
    queue.sort((a, b) => distances.get(a) - distances.get(b));
    const current = queue.shift();
    for (const link of neighbours.get(current) ?? []) {
      const candidate = distances.get(current) + link.length;
      if (candidate < distances.get(link.nodeId) - 1e-9) {
        distances.set(link.nodeId, candidate);
        queue.push(link.nodeId);
      }
    }
  }

  const points = [];
  for (const node of graph.nodes) {
    const distance = distances.get(node.id);
    if (!Number.isFinite(distance) || distance < VENT_DISTANCE_THRESHOLD_MM) continue;
    const links = neighbours.get(node.id) ?? [];
    const isLocalMax = links.every((link) => (distances.get(link.nodeId) ?? 0) <= distance + 1e-9);
    if (isLocalMax) points.push({ nodeId: node.id, distanceMm: distance });
  }
  return points;
}

/** The pocket cut into the top of a slide chip, or null for any other split. */
function slidePocket(chipParams) {
  if (chipParams.splitType !== 'glass-slide') return null;
  const slide = chipParams.slide ?? DEFAULT_CHIP_PARAMS.slide;
  const width = slide.widthMm + slide.clearanceMm * 2;
  const length = slide.lengthMm + slide.clearanceMm * 2;
  const depthMm = slide.thicknessMm + slide.bondGapMm;
  const centerX = chipParams.width / 2 + slide.offsetXMm;
  const centerY = chipParams.length / 2 + slide.offsetYMm;
  return {
    pocket: { x: centerX - width / 2, y: centerY - length / 2, width, length },
    floorZ: chipParams.baseThickness - depthMm,
    depthMm,
  };
}

const overlapsPocket = (rect, x, y, radiusMm) => {
  const nearestX = Math.min(Math.max(x, rect.x), rect.x + rect.width);
  const nearestY = Math.min(Math.max(y, rect.y), rect.y + rect.length);
  return Math.hypot(x - nearestX, y - nearestY) < radiusMm;
};

const insidePocket = (rect, x, y, radiusMm) =>
  x - radiusMm >= rect.x &&
  x + radiusMm <= rect.x + rect.width &&
  y - radiusMm >= rect.y &&
  y + radiusMm <= rect.y + rect.length;

function slideChecks(project, loft) {
  const { chipParams, channelGraph: graph } = project;
  const slide = chipParams.slide ?? DEFAULT_CHIP_PARAMS.slide;
  const solvedPocket = slidePocket(chipParams);
  if (!solvedPocket) return [];

  const { pocket, floorZ, depthMm } = solvedPocket;
  const margin = chipParams.minEdgeSpacing;
  const warnings = [];

  // Does the pocket fit, with the user's own edge spacing left round it?
  const overhangX = Math.max(margin - pocket.x, pocket.x + pocket.width - (chipParams.width - margin));
  const overhangY = Math.max(margin - pocket.y, pocket.y + pocket.length - (chipParams.length - margin));
  const worst = Math.max(overhangX, overhangY);
  if (worst > 1e-6) {
    const offChip =
      pocket.x < 0 ||
      pocket.y < 0 ||
      pocket.x + pocket.width > chipParams.width ||
      pocket.y + pocket.length > chipParams.length;
    warnings.push(
      warn(
        offChip ? 'risk' : 'caution',
        'slide-does-not-fit',
        offChip
          ? `The slide pocket runs ${mm(worst)} mm off the chip`
          : `The slide pocket leaves only a ${mm(margin - worst)} mm rim`,
        offChip
          ? `A ${slide.widthMm} × ${slide.lengthMm} mm slide needs a chip of at least ${mm(slide.widthMm + slide.clearanceMm * 2 + margin * 2)} × ${mm(slide.lengthMm + slide.clearanceMm * 2 + margin * 2)} mm. Enlarge the chip, swap the slide's width and length to turn it, or fit a smaller slide.`
          : `Minimum edge spacing is ${margin} mm and the pocket wall is thinner than that. A thin rim around a pocket cracks easily when the part is released.`,
      ),
    );
  }

  if (floorZ <= 0) {
    warnings.push(
      warn(
        'risk',
        'slide-does-not-fit',
        `The pocket is deeper than the ${chipParams.baseThickness} mm chip`,
        `A ${slide.thicknessMm} mm slide with a ${slide.bondGapMm} mm bond gap cuts ${mm(depthMm)} mm off the top, which is the whole block. Make the chip thicker so there is floor left under the channels.`,
      ),
    );
  }

  // Ports the glass would sit on top of. A chamber under the glass is fine —
  // it is part of the fluid path; only a port has to stay reachable.
  for (const node of graph.nodes) {
    if (node.type !== 'port') continue;
    const radius = nodeFootprintMm(node, chipParams) / 2;
    if (!overlapsPocket(pocket, node.x, node.y, radius)) continue;
    warnings.push(
      warn(
        'risk',
        'port-under-slide',
        `The glass covers port "${node.id}"`,
        'The socket is bored down into the pocket floor, so the slide bonds straight over it and nothing can be connected. Move the port outside the pocket, onto the rim.',
      ),
    );
  }

  // Channels that run out from under the glass. Partial is normal — it is how
  // a channel reaches a rim port — but it is a resin trap worth naming.
  for (const edge of graph.edges) {
    const solved = loft.edges.get(edge.id);
    if (!solved) continue;
    let outside = 0;
    for (const sample of solved.samples) {
      if (insidePocket(pocket, sample.point.x, sample.point.y, sample.widthMm / 2)) continue;
      outside += 1;
    }
    if (outside === 0) continue;
    const whole = outside === solved.samples.length;
    warnings.push(
      warn(
        whole ? 'risk' : 'caution',
        'channel-outside-slide',
        whole
          ? `Segment "${edge.id}" runs entirely outside the slide pocket`
          : `Segment "${edge.id}" runs out from under the slide`,
        whole
          ? 'Nothing opens it, so it prints as a closed tunnel that has to drain through its ends. Move it under the pocket, or enlarge the slide, unless it is a deliberate run out to a port on the rim.'
          : 'The part beyond the pocket keeps its roof, so it prints as a closed tunnel rather than an open groove. That is how a channel reaches a port on the rim — just make sure the resin in it can drain.',
      ),
    );
  }

  const round = graph.edges.filter((edge) => edge.crossSection === 'round');
  if (round.length > 0) {
    warnings.push(
      warn(
        'caution',
        'round-channel-under-slide',
        round.length === 1
          ? 'A round channel prints as a half-round groove here'
          : `${round.length} round channels print as half-round grooves here`,
        'A round section is centred on the open face, so the pocket cuts the top half off and the flat glass closes what is left. The printed channel has about half the area the flow estimates assume. Switch these segments to rect.',
      ),
    );
  }

  return warnings;
}

// ===========================================================================
// reporting
// ===========================================================================

const SEVERITY_ORDER = { risk: 0, caution: 1, info: 2 };

export function report(project, { quiet = false } = {}) {
  const structural = checkStructure(project);
  const warnings = structural.length > 0 ? [] : runChecks(project);
  warnings.sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]);

  const lines = [];
  const graph = project.channelGraph;
  const ports = graph.nodes.filter((n) => n.type === 'port');
  const totalLength = totalChannelLengthMm(graph);

  lines.push(`${project.meta.name} — ${project.chipParams.width} × ${project.chipParams.length} mm, ${project.chipParams.splitType}`);
  lines.push(
    `  ${graph.nodes.length} nodes · ${graph.edges.length} segments · ${ports.length} ports · ${mm(totalLength)} mm of channel`,
  );

  if (structural.length > 0) {
    lines.push('');
    lines.push(`STRUCTURAL ERRORS (${structural.length}) — the app will refuse to open this file:`);
    for (const problem of structural) lines.push(`  ✗ ${problem}`);
    return { ok: false, warnings: [], structural, text: lines.join('\n') };
  }

  const counts = { risk: 0, caution: 0, info: 0 };
  for (const w of warnings) counts[w.severity] += 1;

  lines.push('');
  lines.push(`Design checks: ${counts.risk} risk · ${counts.caution} caution · ${counts.info} info`);
  if (!quiet) {
    for (const w of warnings) {
      const tag = w.severity === 'risk' ? 'RISK   ' : w.severity === 'caution' ? 'CAUTION' : 'INFO   ';
      lines.push(`  ${tag} ${w.title}`);
      lines.push(`          ${w.detail}`);
    }
  }

  const notes = lint(project);
  if (notes.length > 0) {
    lines.push('');
    lines.push(`Authoring notes (${notes.length}) — not OpenChip checks, but usually mistakes:`);
    for (const note of notes) lines.push(`  ! ${note}`);
  }

  return { ok: true, warnings, structural: [], notes, text: lines.join('\n') };
}

export function totalChannelLengthMm(graph) {
  const nodes = new Map(graph.nodes.map((n) => [n.id, n]));
  let total = 0;
  for (const edge of graph.edges) {
    const from = nodes.get(edge.fromNodeId);
    const to = nodes.get(edge.toNodeId);
    if (!from || !to) continue;
    total += cubicLength(edgeCurve(edge, from, to));
  }
  return total;
}

// ===========================================================================
// CLI
// ===========================================================================

function main(argv) {
  const [command, input, ...rest] = argv;

  if (!command || ['-h', '--help', 'help'].includes(command)) {
    console.log(
      [
        'openchip.mjs — compile and check OpenChip designs',
        '',
        '  build <in.chip> [-o out.openchip]   compile Chip-DSL, check it, write the project',
        '  check <file.openchip|file.chip>     run the design checks and print the report',
        '',
        'Both commands always finish: warnings never block a write.',
      ].join('\n'),
    );
    return 0;
  }

  if (!['build', 'check'].includes(command)) {
    console.error(`openchip: unknown command "${command}" — expected build or check`);
    return 2;
  }

  if (!input) {
    console.error(`openchip: ${command} needs an input file`);
    return 2;
  }

  let project;
  try {
    const source = readFileSync(input, 'utf8');
    project = extname(input) === '.openchip' ? JSON.parse(source) : compile(source);
  } catch (error) {
    console.error(`openchip: ${input}: ${error.message}`);
    return 2;
  }

  const result = report(project);

  if (command === 'build') {
    const outIndex = rest.findIndex((a) => a === '-o' || a === '--out');
    const output =
      outIndex !== -1
        ? rest[outIndex + 1]
        : `${basename(input, extname(input))}.openchip`;
    writeFileSync(output, `${JSON.stringify(project, null, 2)}\n`);
    console.log(`Wrote ${output}`);
    console.log('');
  }

  console.log(result.text);
  return result.ok ? 0 : 1;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exit(main(process.argv.slice(2)));
}
