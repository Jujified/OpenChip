/**
 * "Export for presentation" — the schematic, the CAD view and the flow heatmap
 * as one download.
 *
 * Two decisions worth stating, because both look like they could have gone the
 * other way:
 *
 * **It is a ZIP, and it also contains a composed sheet.** "One export" is best
 * read literally — a user who asked for one file should get one file — but a
 * bare archive of three images is not what goes into a slide. So the bundle
 * carries the source assets *and* a single titled figure laying them out
 * together. Whichever the user needed, it is in there.
 *
 * **SVGs are regenerated at the target resolution, not scaled up.** The
 * schematic and the heatmap are written as vectors by their own exporters, so
 * asking for 300 DPI re-emits them at 300 DPI rather than resampling a screen
 * rendering. That is the difference between a figure that survives a projector
 * and one that visibly does not.
 */

import { exportSchematicSvg } from './svgExport';
import { exportHeatmapSvg } from './fluids/heatmapExport';
import { CFD_DISCLAIMER } from './fluids/simulate';
import { METRIC_LABEL, type HeatmapMetric } from './fluids/heatmap';
import { slugify } from './slug';
import { bytesFromDataUri, createZip, textEntry, type ZipEntry } from './zip';
import type { SimulationResult } from './fluids/simulate';
import type {
  ChannelGraph,
  ChipParams,
  FluidSetup,
  PrinterProfile,
  SplitType,
} from '../types/project';

// ---------------------------------------------------------------------------
// options
// ---------------------------------------------------------------------------

export const DPI_CHOICES = [96, 150, 300, 600] as const;
export type Dpi = (typeof DPI_CHOICES)[number];

/** How a split type reads in a caption, rather than as its enum value. */
const SPLIT_LABEL: Record<SplitType, string> = {
  'two-piece': 'two-piece',
  monolithic: 'monolithic',
  'glass-slide': 'glass slide',
};

export const DPI_LABEL: Record<Dpi, string> = {
  96: 'Screen · 96 DPI',
  150: 'Draft print · 150 DPI',
  300: 'Print · 300 DPI',
  600: 'Large format · 600 DPI',
};

export interface PresentationSource {
  projectName: string;
  graph: ChannelGraph;
  chipParams: ChipParams;
  printerProfile: PrinterProfile;
  fluidSetup: FluidSetup;
  /** Null until the CAD tab has been opened at least once this session. */
  cadSnapshotDataUri: string | null;
  /** Null when the design has no runnable flow estimate. */
  heatmap: { result: SimulationResult; metric: HeatmapMetric } | null;
}

export interface PresentationOptions {
  dpi: Dpi;
  includeSchematic: boolean;
  includeCad: boolean;
  includeHeatmap: boolean;
  includeSheet: boolean;
}

export interface PresentationBundle {
  bytes: Uint8Array<ArrayBuffer>;
  fileName: string;
  /** Names of everything that made it in, for the confirmation toast. */
  contents: string[];
}

// ---------------------------------------------------------------------------
// sheet geometry
// ---------------------------------------------------------------------------

/**
 * 16:9, sized in millimetres.
 *
 * A slide, not a page: this figure's destination is almost always a projector
 * or a screen-shared deck, and letterboxing a portrait page into one is the
 * most common way a good figure ends up unreadable.
 */
const SHEET = { width: 254, height: 143, margin: 10 } as const;
const BODY_TOP = 32;
const BODY_BOTTOM = 126;
const PANEL_GAP = 6;
const LABEL_HEIGHT = 5;

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * Where each panel sits, in sheet millimetres.
 *
 * The three-panel case is deliberately asymmetric: the schematic is the drawing
 * with real dimensions on it and is the one a reader will actually try to read,
 * so it gets the tall left column while the two renderings stack beside it.
 */
export function sheetLayout(count: number): Rect[] {
  const left = SHEET.margin;
  const width = SHEET.width - SHEET.margin * 2;
  const top = BODY_TOP;
  const height = BODY_BOTTOM - BODY_TOP;

  if (count <= 1) return [{ x: left, y: top, w: width, h: height }];

  if (count === 2) {
    const half = (width - PANEL_GAP) / 2;
    return [
      { x: left, y: top, w: half, h: height },
      { x: left + half + PANEL_GAP, y: top, w: half, h: height },
    ];
  }

  const columnWidth = (width - PANEL_GAP) * 0.42;
  const rightX = left + columnWidth + PANEL_GAP;
  const rightWidth = width - columnWidth - PANEL_GAP;
  const rowHeight = (height - PANEL_GAP) / 2;

  return [
    { x: left, y: top, w: columnWidth, h: height },
    { x: rightX, y: top, w: rightWidth, h: rowHeight },
    { x: rightX, y: top + rowHeight + PANEL_GAP, w: rightWidth, h: rowHeight },
  ];
}

// ---------------------------------------------------------------------------
// raster helpers
// ---------------------------------------------------------------------------

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.decoding = 'sync';
    image.addEventListener('load', () => resolve(image));
    image.addEventListener('error', () => reject(new Error('An image failed to decode.')));
    image.src = src;
  });
}

async function loadSvg(svg: string): Promise<HTMLImageElement> {
  const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml;charset=utf-8' }));
  try {
    return await loadImage(url);
  } finally {
    // Safe once the load has settled: the decoded bitmap is retained by the
    // element, and revoking early is a classic way to get a blank drawImage.
    URL.revokeObjectURL(url);
  }
}

/** Fits an image inside a box without distorting it. */
function drawContain(
  ctx: CanvasRenderingContext2D,
  image: HTMLImageElement,
  box: Rect,
): void {
  const natural = image.naturalWidth / Math.max(image.naturalHeight, 1);
  if (!Number.isFinite(natural) || natural <= 0) return;

  let w = box.w;
  let h = w / natural;
  if (h > box.h) {
    h = box.h;
    w = h * natural;
  }

  ctx.drawImage(image, box.x + (box.w - w) / 2, box.y + (box.h - h) / 2, w, h);
}

async function canvasToPngBytes(canvas: HTMLCanvasElement): Promise<Uint8Array<ArrayBuffer>> {
  const blob = await new Promise<Blob | null>((resolve) =>
    canvas.toBlob((result) => resolve(result), 'image/png'),
  );
  if (!blob) throw new Error('The presentation sheet could not be rendered.');
  return new Uint8Array(await blob.arrayBuffer());
}

// ---------------------------------------------------------------------------
// the sheet
// ---------------------------------------------------------------------------

interface Panel {
  label: string;
  image: HTMLImageElement;
}

async function composeSheet(
  panels: Panel[],
  source: PresentationSource,
  dpi: Dpi,
): Promise<Uint8Array> {
  const mmToPx = dpi / 25.4;
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(SHEET.width * mmToPx);
  canvas.height = Math.round(SHEET.height * mmToPx);

  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('This browser would not give us a canvas to draw on.');

  // Everything below is written in sheet millimetres.
  ctx.scale(mmToPx, mmToPx);

  // Printed and pasted into light documents, so the sheet is light regardless
  // of the app's colour scheme — a dark figure in a white deck is a mistake the
  // user only discovers on the projector.
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, SHEET.width, SHEET.height);

  const sans = 'ui-sans-serif, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif';
  const mono = 'ui-monospace, "SF Mono", Menlo, Consolas, monospace';

  ctx.fillStyle = '#18181b';
  ctx.font = `600 6.4px ${sans}`;
  ctx.textBaseline = 'alphabetic';
  ctx.fillText(source.projectName, SHEET.margin, 18);

  ctx.fillStyle = '#6b7280';
  ctx.font = `3.1px ${mono}`;
  ctx.fillText(subtitleFor(source), SHEET.margin, 24.5);

  ctx.strokeStyle = '#d4d4d8';
  ctx.lineWidth = 0.25;
  rule(ctx, 28);
  rule(ctx, BODY_BOTTOM + 4);

  const boxes = sheetLayout(panels.length);

  panels.forEach((panel, index) => {
    const box = boxes[index];
    if (!box) return;

    ctx.fillStyle = '#6b7280';
    ctx.font = `600 2.9px ${mono}`;
    ctx.fillText(panel.label.toUpperCase(), box.x, box.y + 3);

    const frame: Rect = {
      x: box.x,
      y: box.y + LABEL_HEIGHT,
      w: box.w,
      h: box.h - LABEL_HEIGHT,
    };

    ctx.strokeStyle = '#e4e4e7';
    ctx.lineWidth = 0.25;
    ctx.strokeRect(frame.x, frame.y, frame.w, frame.h);

    // Inset so a drawing never touches its own frame.
    drawContain(ctx, panel.image, {
      x: frame.x + 2,
      y: frame.y + 2,
      w: frame.w - 4,
      h: frame.h - 4,
    });
  });

  ctx.fillStyle = '#9ca3af';
  ctx.font = `2.6px ${sans}`;
  ctx.fillText(
    source.heatmap ? CFD_DISCLAIMER : 'Drawn with OpenChip. Dimensions in millimetres.',
    SHEET.margin,
    BODY_BOTTOM + 9.5,
  );

  return canvasToPngBytes(canvas);
}

function rule(ctx: CanvasRenderingContext2D, y: number): void {
  ctx.beginPath();
  ctx.moveTo(SHEET.margin, y);
  ctx.lineTo(SHEET.width - SHEET.margin, y);
  ctx.stroke();
}

function subtitleFor(source: PresentationSource): string {
  const { chipParams, graph } = source;
  const ports = graph.nodes.filter((n) => n.type === 'port').length;
  return [
    `${chipParams.width} × ${chipParams.length} × ${chipParams.baseThickness} mm`,
    `${graph.edges.length} segments`,
    `${ports} ports`,
    SPLIT_LABEL[chipParams.splitType],
    new Date().toISOString().slice(0, 10),
  ].join('  ·  ');
}

// ---------------------------------------------------------------------------
// the bundle
// ---------------------------------------------------------------------------

export async function buildPresentationBundle(
  source: PresentationSource,
  options: PresentationOptions,
): Promise<PresentationBundle> {
  const mmToPx = options.dpi / 25.4;
  const boxCount =
    Number(options.includeSchematic) +
    Number(options.includeCad && source.cadSnapshotDataUri !== null) +
    Number(options.includeHeatmap && source.heatmap !== null);
  const boxes = sheetLayout(Math.max(boxCount, 1));

  const entries: ZipEntry[] = [];
  const panels: Panel[] = [];
  const contents: string[] = [];
  let panelIndex = 0;

  /** Pixels-per-mm that makes an SVG land at its panel's true resolution. */
  const ppmFor = (chipSpanMm: number): number => {
    const box = boxes[Math.min(panelIndex, boxes.length - 1)] ?? boxes[0];
    const targetPx = box.w * mmToPx;
    // The exporters add their own margin around the chip; approximating it is
    // fine because the sheet fits the result rather than assuming its size.
    return Math.max(4, targetPx / (chipSpanMm + 8));
  };

  if (options.includeSchematic) {
    const svg = exportSchematicSvg(source.graph, source.chipParams, {
      pixelsPerMm: ppmFor(source.chipParams.width),
      title: `${source.projectName} — schematic`,
    });
    entries.push(textEntry('schematic.svg', svg));
    contents.push('schematic.svg');
    if (options.includeSheet) {
      panels.push({ label: 'Schematic', image: await loadSvg(svg) });
      panelIndex += 1;
    }
  }

  if (options.includeCad && source.cadSnapshotDataUri) {
    entries.push({
      name: 'cad-view.png',
      data: bytesFromDataUri(source.cadSnapshotDataUri),
    });
    contents.push('cad-view.png');
    if (options.includeSheet) {
      panels.push({ label: 'CAD view', image: await loadImage(source.cadSnapshotDataUri) });
      panelIndex += 1;
    }
  }

  if (options.includeHeatmap && source.heatmap) {
    const { result, metric } = source.heatmap;
    const svg = exportHeatmapSvg(
      source.graph,
      source.chipParams,
      source.fluidSetup,
      result,
      metric,
      {
        pixelsPerMm: ppmFor(source.chipParams.width),
        title: `${source.projectName} — ${METRIC_LABEL[metric].toLowerCase()}`,
      },
    );
    entries.push(textEntry('flow-heatmap.svg', svg));
    contents.push('flow-heatmap.svg');
    if (options.includeSheet) {
      panels.push({ label: METRIC_LABEL[metric], image: await loadSvg(svg) });
      panelIndex += 1;
    }
  }

  if (options.includeSheet && panels.length > 0) {
    entries.unshift({
      name: 'presentation-sheet.png',
      data: await composeSheet(panels, source, options.dpi),
    });
    contents.unshift('presentation-sheet.png');
  }

  entries.push(textEntry('README.txt', readmeFor(source, options, contents)));

  return {
    bytes: createZip(entries),
    fileName: `${slugify(source.projectName)}-presentation.zip`,
    contents,
  };
}

function readmeFor(
  source: PresentationSource,
  options: PresentationOptions,
  contents: string[],
): string {
  const { chipParams, printerProfile } = source;

  const lines = [
    `${source.projectName} — presentation bundle`,
    `Exported from OpenChip on ${new Date().toISOString().slice(0, 16).replace('T', ' ')}`,
    '',
    'CONTENTS',
    ...contents.map((name) => `  ${name}${describe(name)}`),
    '  README.txt — this file',
    '',
    'CHIP',
    `  Footprint            ${chipParams.width} × ${chipParams.length} mm`,
    `  Base thickness       ${chipParams.baseThickness} mm`,
    `  Wall thickness       ${chipParams.wallThickness} mm`,
    `  Minimum edge spacing ${chipParams.minEdgeSpacing} mm`,
    `  Split                ${SPLIT_LABEL[chipParams.splitType]}${
      chipParams.splitType === 'two-piece' ? ` at ${chipParams.splitHeight} mm` : ''
    }${
      chipParams.splitType === 'glass-slide'
        ? ` for a ${chipParams.slide.widthMm} × ${chipParams.slide.lengthMm} × ${chipParams.slide.thicknessMm} mm slide`
        : ''
    }`,
    `  Default channel      ${chipParams.defaultChannelWidthMm} × ${chipParams.defaultChannelHeightMm} mm, ${chipParams.defaultCrossSection}`,
    '',
    'PRINTER PROFILE',
    `  ${printerProfile.name}`,
    `  XY resolution        ${printerProfile.xyResolutionMicrons} µm`,
    `  Layer height         ${printerProfile.layerHeightMicrons} µm`,
    `  Minimum feature      ${printerProfile.minFeatureSizeMm} mm`,
    '',
    `Raster output rendered at ${options.dpi} DPI. The SVGs are vector and scale`,
    'without loss — prefer them wherever the destination accepts them.',
  ];

  if (source.heatmap) {
    lines.push('', 'ABOUT THE FLOW FIGURE', `  ${CFD_DISCLAIMER}`);
  }

  return `${lines.join('\n')}\n`;
}

function describe(name: string): string {
  switch (name) {
    case 'presentation-sheet.png':
      return ' — all of the below laid out as one 16:9 figure';
    case 'schematic.svg':
      return ' — dimensioned 2D drawing, vector';
    case 'cad-view.png':
      return ' — the 3D viewport as it was framed on export';
    case 'flow-heatmap.svg':
      return ' — flow estimate over the channel network, vector';
    default:
      return '';
  }
}
