/**
 * Presentation-ready SVG of the current heatmap.
 *
 * Written directly rather than screenshotting the canvas, for the same reason
 * the SVG schematic is: an export should be a clean figure with a title,
 * a legend and a scale bar, not a picture of a UI. Vector also means it stays
 * sharp in a slide at any size.
 */

import { newId } from '../defaults';
import { edgeCurve, nodeIndex, nodePoint, perpendicular } from '../geometry';
import { getLoft } from '../loft';
import { portFootprintMm } from '../ports';
import { escapeXml } from '../xml';
import {
  buildScale,
  METRIC_BAND_NOTE,
  METRIC_LABEL,
  METRIC_UNIT,
  metricDomain,
  metricValue,
  type HeatmapMetric,
} from './heatmap';
import { REGIME_LABEL } from './hydraulics';
import type { SimulationResult } from './simulate';
import type {
  ChannelGraph,
  ChipParams,
  FluidSetup,
  SavedImage,
} from '../../types/project';

const f = (n: number): string => String(Math.round(n * 1000) / 1000);

export interface HeatmapExportOptions {
  marginMm?: number;
  pixelsPerMm?: number;
  title?: string;
}

export function exportHeatmapSvg(
  graph: ChannelGraph,
  chipParams: ChipParams,
  fluidSetup: FluidSetup,
  result: SimulationResult,
  metric: HeatmapMetric,
  options: HeatmapExportOptions = {},
): string {
  const { marginMm = 4, pixelsPerMm = 10, title = 'OpenChip flow estimate' } = options;

  const loft = getLoft(graph, chipParams);
  const nodes = nodeIndex(graph.nodes);
  const bySegment = new Map(result.segments.map((s) => [s.edgeId, s]));
  const assignments = new Map(fluidSetup.assignments.map((a) => [a.portId, a]));

  const inletTemps = result.segments.map((s) => s.temperatureInC);
  const scale = buildScale(
    metric,
    metricDomain(metric, result.segments),
    {
      // Exports are printed and pasted into light documents.
      dark: false,
      centerC:
        metric === 'temperature' && inletTemps.length > 0
          ? inletTemps.reduce((a, b) => a + b, 0) / inletTemps.length
          : undefined,
    },
  );

  const legendMm = 12;
  const headerMm = 7;
  const totalW = chipParams.width + marginMm * 2;
  const totalH = chipParams.length + marginMm * 2 + legendMm + headerMm;

  const body: string[] = [];

  // --- chip outline ---------------------------------------------------------
  body.push(
    `<rect x="0" y="0" width="${f(chipParams.width)}" height="${f(chipParams.length)}" ` +
      `fill="none" stroke="#3f3f46" stroke-width="0.2"/>`,
  );

  // --- channels -------------------------------------------------------------
  for (const edge of graph.edges) {
    const solved = loft.edges.get(edge.id);
    const segment = bySegment.get(edge.id);
    if (!solved || solved.samples.length < 2) continue;

    const colour = segment ? scale.colorAt(metricValue(metric, segment)) : '#c9c9c9';

    const left: { x: number; y: number }[] = [];
    const right: { x: number; y: number }[] = [];
    for (const sample of solved.samples) {
      const normal = perpendicular(sample.tangent);
      const half = Math.max(sample.widthMm / 2, 0.15);
      left.push({ x: sample.point.x + normal.x * half, y: sample.point.y + normal.y * half });
      right.push({ x: sample.point.x - normal.x * half, y: sample.point.y - normal.y * half });
    }

    const ring = [...left, ...right.reverse()];
    const d = ring.map((p, i) => `${i === 0 ? 'M' : 'L'} ${f(p.x)} ${f(p.y)}`).join(' ');
    body.push(`<path d="${d} Z" fill="${colour}" stroke="none"/>`);

    // A hairline centerline keeps a hair-thin channel visible at print size,
    // where the coloured band can fall below one device pixel.
    const from = nodes.get(edge.fromNodeId);
    const to = nodes.get(edge.toNodeId);
    if (from && to) {
      const curve = edgeCurve(edge, nodePoint(from), nodePoint(to));
      body.push(
        `<path d="M ${f(curve.p0.x)} ${f(curve.p0.y)} C ${f(curve.c0.x)} ${f(curve.c0.y)}, ` +
          `${f(curve.c1.x)} ${f(curve.c1.y)}, ${f(curve.p1.x)} ${f(curve.p1.y)}" ` +
          `fill="none" stroke="${colour}" stroke-width="0.08"/>`,
      );
    }
  }

  // --- ports ----------------------------------------------------------------
  const labels: string[] = [];
  for (const node of graph.nodes) {
    if (node.type !== 'port') continue;
    const assignment = assignments.get(node.id);
    const radius = Math.max(portFootprintMm(node.portType, node.customSpec) / 2, 0.8);
    const inlet = assignment?.role === 'inlet';

    body.push(
      `<circle cx="${f(node.x)}" cy="${f(node.y)}" r="${f(radius)}" fill="#ffffff" ` +
        `stroke="${inlet ? '#2a78d6' : '#6b7280'}" stroke-width="0.18"/>`,
    );
    if (inlet) {
      body.push(
        `<circle cx="${f(node.x)}" cy="${f(node.y)}" r="${f(radius * 0.45)}" fill="#2a78d6"/>`,
      );
      const segment = result.segments.find(
        (s) => s.edgeId && graph.edges.some((e) => e.id === s.edgeId && (e.fromNodeId === node.id || e.toNodeId === node.id)),
      );
      labels.push(
        textAt(
          node.x + radius + 0.5,
          node.y,
          `${assignment?.flowRateUlPerMin ?? 0} µL/min${segment ? ` · ${segment.fluidName}` : ''}`,
        ),
      );
    }
  }
  body.push(...labels);

  // --- legend ---------------------------------------------------------------
  const gradientId = 'oc-heat';
  const stops = scale.stops
    .map((hex, i) => `<stop offset="${((i / (scale.stops.length - 1)) * 100).toFixed(1)}%" stop-color="${hex}"/>`)
    .join('');

  const legendW = Math.min(chipParams.width * 0.75, 40);
  const legendY = -legendMm + 4;

  const legend: string[] = [
    `<rect x="0" y="${f(legendY)}" width="${f(legendW)}" height="2" fill="url(#${gradientId})" stroke="#3f3f46" stroke-width="0.08"/>`,
  ];

  for (const band of scale.bands) {
    const x = band.position * legendW;
    legend.push(
      `<path d="M ${f(x)} ${f(legendY)} L ${f(x)} ${f(legendY + 2)}" stroke="#111111" stroke-width="0.12"/>`,
    );
  }

  // Band names go on their own row rather than beside their ticks: at these
  // scales the positioned labels overlapped each other and the range values.
  if (scale.bands.length > 0) {
    legend.push(
      textAt(
        0,
        legendY + 4.7,
        scale.bands.map((b) => `${b.label} above ${formatValue(b.value)}`).join('   ·   '),
        '#52525b',
        0.75,
      ),
    );
  }

  // An exported figure outlives the app it came from, so a band that names a
  // biological outcome carries its caveat into the file rather than leaving it
  // behind on screen. Shortened to fit the legend's width; the panel carries
  // the full wording.
  if (scale.bands.length > 0 && METRIC_BAND_NOTE[metric]) {
    legend.push(
      textAt(
        0,
        legendY - 2.6,
        'Reference points only — tolerance varies by cell type, exposure and adherence.',
        '#6b7280',
        0.65,
      ),
    );
  }

  // A log scale the reader cannot see is a lie, so it is stated in the title
  // rather than left to be inferred from the tick spacing.
  legend.push(
    textAt(
      0,
      legendY - 0.9,
      `${METRIC_LABEL[metric]}${METRIC_UNIT[metric] ? ` (${METRIC_UNIT[metric]})` : ''}` +
        `${scale.logarithmic ? ' — log scale' : ''}`,
      '#111111',
      1,
    ),
  );
  // Ends formatted against the span, not each on its own: a shear scale running
  // 0.005 to 0.010 Pa printed at two decimals gives "0.01" at both ends, and a
  // legend whose two labels agree tells the reader nothing about either.
  const formatEnd = rangeFormatter(scale.min, scale.max);
  legend.push(textAt(0, legendY + 3.2, formatEnd(scale.min), '#3f3f46', 0.8));
  legend.push(textAt(legendW, legendY + 3.2, formatEnd(scale.max), '#3f3f46', 0.8, 'end'));

  // --- header ---------------------------------------------------------------
  const worst = result.segments.reduce(
    (acc, s) => (s.reynolds > acc.reynolds ? s : acc),
    result.segments[0],
  );
  const summary = worst
    ? `max ΔP ${Math.round(result.maxPressurePa)} Pa · peak Re ${worst.reynolds.toFixed(worst.reynolds < 10 ? 2 : 0)} (${REGIME_LABEL[worst.regime]})`
    : '';

  const header = [
    textAt(0, chipParams.length + 3.2, title, '#111111', 1.3),
    textAt(0, chipParams.length + 1.4, summary, '#52525b', 0.85),
    textAt(
      chipParams.width,
      chipParams.length + 1.4,
      'Estimates, not a CFD simulation',
      '#6b7280',
      0.75,
      'end',
    ),
  ];

  return [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<svg xmlns="http://www.w3.org/2000/svg" width="${f(totalW * pixelsPerMm)}" height="${f(totalH * pixelsPerMm)}" `,
    `viewBox="0 0 ${f(totalW)} ${f(totalH)}" role="img" aria-label="${escapeXml(title)}">`,
    `<title>${escapeXml(title)}</title>`,
    `<defs><linearGradient id="${gradientId}" x1="0" y1="0" x2="1" y2="0">${stops}</linearGradient></defs>`,
    `<rect width="100%" height="100%" fill="#ffffff"/>`,
    // Flip Y so chip millimetres can be written directly.
    `<g transform="translate(${f(marginMm)} ${f(totalH - marginMm - legendMm)}) scale(1 -1)">`,
    body.join('\n'),
    legend.join('\n'),
    header.join('\n'),
    `</g>`,
    `</svg>`,
  ].join('\n');
}

/** Text is emitted pre-flipped so it reads upright inside the flipped group. */
function textAt(
  x: number,
  y: number,
  content: string,
  fill = '#3f3f46',
  size = 0.9,
  anchor: 'start' | 'end' = 'start',
): string {
  return (
    `<g transform="translate(${f(x)} ${f(y)}) scale(1 -1)">` +
    `<text x="0" y="0" font-family="ui-sans-serif, system-ui, sans-serif" font-size="${f(size)}" ` +
    `fill="${fill}" text-anchor="${anchor}" dominant-baseline="middle">${escapeXml(content)}</text></g>`
  );
}

/** A single named value — a band threshold. */
function formatValue(value: number): string {
  const abs = Math.abs(value);
  if (abs >= 100_000) return value.toExponential(1);
  if (abs >= 1000) return Math.round(value).toLocaleString();
  if (abs >= 10) return value.toFixed(0);
  return value.toFixed(2);
}

/** Decimals chosen once from a range, so both ends are told apart. */
function rangeFormatter(min: number, max: number): (value: number) => string {
  const span = Math.abs(max - min);
  const largest = Math.max(Math.abs(min), Math.abs(max));

  if (largest >= 100_000 || (span > 0 && span < 1e-3)) {
    return (value) => value.toExponential(1);
  }
  if (largest >= 1000) return (value) => Math.round(value).toLocaleString();

  const decimals = span >= 10 ? 0 : span >= 1 ? 1 : span >= 0.1 ? 2 : 3;
  return (value) => value.toFixed(decimals);
}

/** Wraps the SVG as a `SavedImage` ready to drop into the project. */
export function heatmapSavedImage(
  graph: ChannelGraph,
  chipParams: ChipParams,
  fluidSetup: FluidSetup,
  result: SimulationResult,
  metric: HeatmapMetric,
  label: string,
): SavedImage {
  const svg = exportHeatmapSvg(graph, chipParams, fluidSetup, result, metric, { title: label });

  return {
    id: newId(),
    kind: 'heatmap',
    label,
    createdAt: new Date().toISOString(),
    mimeType: 'image/svg+xml',
    // `;charset=utf-8` matters: without it the browser decodes the base64 as
    // Latin-1 and every µ, × and em-dash comes back as mojibake.
    data: `data:image/svg+xml;charset=utf-8;base64,${base64Utf8(svg)}`,
  };
}

/** Base64 of the UTF-8 bytes — `btoa` alone throws on any non-Latin-1 character. */
function base64Utf8(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}
