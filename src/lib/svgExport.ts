/**
 * Schematic SVG export.
 *
 * Written directly rather than via Paper's `exportSVG` so the output is a clean,
 * labelled drawing instead of a dump of the interactive scene — no selection
 * rings, no snap crosses, no hover state, and real dimension annotations that
 * only make sense on paper.
 *
 * It consumes the same `solveLoft` output the canvas renders, so the exported
 * taper is the taper the user was looking at.
 */

import { newId } from './defaults';
import { edgeCurve, nodeIndex, nodePoint, perpendicular } from './geometry';
import { chainMarkers, getLoft, type LoftSolution } from './loft';
import { portFootprintMm } from './ports';
import { escapeXml } from './xml';
import type {
  ChannelGraph,
  ChipParams,
  Point2,
  SavedImage,
} from '../types/project';

export interface SvgExportOptions {
  /** Millimetres of blank space around the chip outline. */
  marginMm?: number;
  /** Output scale, pixels per millimetre. */
  pixelsPerMm?: number;
  showGrid?: boolean;
  showDimensions?: boolean;
  showTaper?: boolean;
  title?: string;
}

const fmt = (n: number): string => (Math.round(n * 1000) / 1000).toString();

/**
 * SVG's Y axis points down and chip space points up, so the whole drawing is
 * emitted inside one flipping transform. Every coordinate below is therefore
 * plain chip millimetres, which keeps this readable.
 */
export function exportSchematicSvg(
  graph: ChannelGraph,
  chipParams: ChipParams,
  options: SvgExportOptions = {},
): string {
  const {
    marginMm = 4,
    pixelsPerMm = 8,
    showGrid = true,
    showDimensions = true,
    showTaper = true,
    title = 'OpenChip schematic',
  } = options;

  const loft: LoftSolution = getLoft(graph, chipParams);
  const nodes = nodeIndex(graph.nodes);

  const parts: string[] = [];

  // --- grid ----------------------------------------------------------------
  if (showGrid) {
    const lines: string[] = [];
    for (let x = 0; x <= chipParams.width; x += 5) {
      lines.push(`M ${fmt(x)} 0 L ${fmt(x)} ${fmt(chipParams.length)}`);
    }
    for (let y = 0; y <= chipParams.length; y += 5) {
      lines.push(`M 0 ${fmt(y)} L ${fmt(chipParams.width)} ${fmt(y)}`);
    }
    parts.push(
      `<path d="${lines.join(' ')}" fill="none" stroke="#d4d4d8" stroke-width="0.05" opacity="0.7"/>`,
    );
  }

  // --- chip outline + clearance band ---------------------------------------
  parts.push(
    `<rect x="0" y="0" width="${fmt(chipParams.width)}" height="${fmt(chipParams.length)}" ` +
      `fill="none" stroke="#3f3f46" stroke-width="0.2"/>`,
  );

  const inset = chipParams.minEdgeSpacing;
  if (inset > 0 && chipParams.width > inset * 2 && chipParams.length > inset * 2) {
    parts.push(
      `<rect x="${fmt(inset)}" y="${fmt(inset)}" width="${fmt(chipParams.width - inset * 2)}" ` +
        `height="${fmt(chipParams.length - inset * 2)}" fill="none" stroke="#b45309" ` +
        `stroke-width="0.1" stroke-dasharray="0.6 0.6" opacity="0.6"/>`,
    );
  }

  // --- channels ------------------------------------------------------------
  for (const edge of graph.edges) {
    const from = nodes.get(edge.fromNodeId);
    const to = nodes.get(edge.toNodeId);
    if (!from || !to) continue;

    if (showTaper) {
      const solved = loft.edges.get(edge.id);
      if (solved && solved.samples.length > 1) {
        const left: Point2[] = [];
        const right: Point2[] = [];
        for (const sample of solved.samples) {
          const normal = perpendicular(sample.tangent);
          const half = sample.widthMm / 2;
          left.push({
            x: sample.point.x + normal.x * half,
            y: sample.point.y + normal.y * half,
          });
          right.push({
            x: sample.point.x - normal.x * half,
            y: sample.point.y - normal.y * half,
          });
        }
        const ring = [...left, ...right.reverse()];
        const d = ring.map((p, i) => `${i === 0 ? 'M' : 'L'} ${fmt(p.x)} ${fmt(p.y)}`).join(' ');
        parts.push(`<path d="${d} Z" fill="#5850ec" fill-opacity="0.18" stroke="none"/>`);
      }
    }

    const curve = edgeCurve(edge, nodePoint(from), nodePoint(to));
    parts.push(
      `<path d="M ${fmt(curve.p0.x)} ${fmt(curve.p0.y)} C ${fmt(curve.c0.x)} ${fmt(curve.c0.y)}, ` +
        `${fmt(curve.c1.x)} ${fmt(curve.c1.y)}, ${fmt(curve.p1.x)} ${fmt(curve.p1.y)}" ` +
        `fill="none" stroke="#18181b" stroke-width="0.12" stroke-linecap="round"/>`,
    );
  }

  // --- nodes ---------------------------------------------------------------
  const labels: string[] = [];
  const legend: string[] = [];

  // Chambers are grouped by shape and size. A serpentine can carry a dozen
  // identical ones, and labelling each inline overprints them into an
  // unreadable smear — so repeats become a single legend row instead.
  const chamberGroups = new Map<string, { count: number; shape: string; sizeMm: number }>();
  for (const node of graph.nodes) {
    if (node.type !== 'chamber') continue;
    const key = `${node.shape}:${fmt(node.sizeMm)}`;
    const existing = chamberGroups.get(key);
    if (existing) existing.count += 1;
    else chamberGroups.set(key, { count: 1, shape: node.shape, sizeMm: node.sizeMm });
  }

  /** Inline labels stay readable up to this many identical chambers. */
  const INLINE_CHAMBER_LIMIT = 2;

  for (const node of graph.nodes) {
    if (node.type === 'chamber') {
      parts.push(
        `<circle cx="${fmt(node.x)}" cy="${fmt(node.y)}" r="${fmt(node.sizeMm / 2)}" ` +
          `fill="#5850ec" fill-opacity="0.2" stroke="#5850ec" stroke-width="0.12"/>`,
      );
      const group = chamberGroups.get(`${node.shape}:${fmt(node.sizeMm)}`);
      if (group && group.count <= INLINE_CHAMBER_LIMIT) {
        labels.push(
          textAt(node.x + node.sizeMm / 2 + 0.6, node.y, `${fmt(node.sizeMm)} mm ${node.shape}`),
        );
      }
    } else if (node.type === 'port') {
      const footprint = portFootprintMm(node.portType, node.customSpec);
      parts.push(
        `<circle cx="${fmt(node.x)}" cy="${fmt(node.y)}" r="${fmt(footprint / 2)}" ` +
          `fill="#ffffff" stroke="#5850ec" stroke-width="0.15"/>`,
        `<circle cx="${fmt(node.x)}" cy="${fmt(node.y)}" r="${fmt(node.diameterMm / 2)}" fill="#5850ec"/>`,
      );
      // Ports are few and each may differ, so they stay labelled in place.
      labels.push(textAt(node.x + footprint / 2 + 0.6, node.y, `${node.portType} ⌀${fmt(node.diameterMm)}`));
    } else {
      parts.push(
        `<circle cx="${fmt(node.x)}" cy="${fmt(node.y)}" r="0.25" fill="#ffffff" stroke="#52525b" stroke-width="0.08"/>`,
      );
    }
  }

  for (const group of chamberGroups.values()) {
    if (group.count > INLINE_CHAMBER_LIMIT) {
      legend.push(`${group.count} × ⌀${fmt(group.sizeMm)} mm ${group.shape} chambers`);
    }
  }

  // --- dimension annotations ------------------------------------------------
  if (showDimensions) {
    for (const chain of loft.chains) {
      for (const marker of chainMarkers(chain)) {
        const solved = loft.edges.get(marker.edgeId);
        if (!solved || solved.samples.length === 0) continue;

        const member = chain.members.find((m) => m.edge.id === marker.edgeId);
        const local = member?.reversed ? 1 - marker.t : marker.t;
        const index = Math.round(local * (solved.samples.length - 1));
        const sample = solved.samples[Math.max(0, Math.min(solved.samples.length - 1, index))];

        const normal = perpendicular(sample.tangent);
        const tickHalf = Math.max(sample.widthMm / 2 + 0.4, 0.8);
        const a = {
          x: sample.point.x + normal.x * tickHalf,
          y: sample.point.y + normal.y * tickHalf,
        };
        const b = {
          x: sample.point.x - normal.x * tickHalf,
          y: sample.point.y - normal.y * tickHalf,
        };

        parts.push(
          `<path d="M ${fmt(a.x)} ${fmt(a.y)} L ${fmt(b.x)} ${fmt(b.y)}" stroke="#b45309" stroke-width="0.08"/>`,
        );
        labels.push(
          textAt(a.x + 0.4, a.y, `${fmt(marker.widthMm)} mm`, '#b45309'),
        );
      }
    }
  }

  // Labels go last so nothing paints over them.
  parts.push(...labels);

  // The footer band sits below the chip and holds the scale bar plus any
  // legend rows, so neither can collide with the drawing.
  const LEGEND_ROW_MM = 1.7;
  const footerMm = 3.4 + legend.length * LEGEND_ROW_MM;

  const totalW = chipParams.width + marginMm * 2;
  const totalH = chipParams.length + marginMm * 2 + footerMm;
  const pxW = totalW * pixelsPerMm;
  const pxH = totalH * pixelsPerMm;

  const footer = [
    buildScaleBar(chipParams),
    ...legend.map((line, i) => {
      const y = -3.6 - (i + 1) * LEGEND_ROW_MM;
      return [
        `<circle cx="0.5" cy="${fmt(y)}" r="0.45" fill="#5850ec" fill-opacity="0.2" stroke="#5850ec" stroke-width="0.1"/>`,
        textAt(1.5, y, line),
      ].join('\n');
    }),
  ].join('\n');

  return [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<svg xmlns="http://www.w3.org/2000/svg" width="${fmt(pxW)}" height="${fmt(pxH)}" `,
    `viewBox="0 0 ${fmt(totalW)} ${fmt(totalH)}" role="img" aria-label="${escapeXml(title)}">`,
    `<title>${escapeXml(title)}</title>`,
    `<rect width="100%" height="100%" fill="#ffffff"/>`,
    // Flip Y, and put the origin at the chip's bottom-left corner — everything
    // above is written in plain chip millimetres because of this.
    `<g transform="translate(${fmt(marginMm)} ${fmt(totalH - marginMm - footerMm)}) scale(1 -1)">`,
    parts.join('\n'),
    footer,
    `</g>`,
    `</svg>`,
  ].join('\n');
}

/** Text is emitted pre-flipped so it reads the right way up in the output. */
function textAt(x: number, y: number, content: string, fill = '#3f3f46'): string {
  return (
    `<g transform="translate(${fmt(x)} ${fmt(y)}) scale(1 -1)">` +
    `<text x="0" y="0" font-family="ui-monospace, monospace" font-size="0.9" fill="${fill}" ` +
    `dominant-baseline="middle">${escapeXml(content)}</text></g>`
  );
}

function buildScaleBar(chipParams: ChipParams): string {
  // A round bar length that fits comfortably: a fifth of the chip, rounded down.
  const candidates = [1, 2, 5, 10, 20, 50];
  const target = chipParams.width / 5;
  const barMm = candidates.filter((c) => c <= target).pop() ?? 1;

  const y = -2.2;
  return [
    `<g>`,
    `<path d="M 0 ${fmt(y)} L ${fmt(barMm)} ${fmt(y)}" stroke="#3f3f46" stroke-width="0.15"/>`,
    `<path d="M 0 ${fmt(y - 0.35)} L 0 ${fmt(y + 0.35)}" stroke="#3f3f46" stroke-width="0.15"/>`,
    `<path d="M ${fmt(barMm)} ${fmt(y - 0.35)} L ${fmt(barMm)} ${fmt(y + 0.35)}" stroke="#3f3f46" stroke-width="0.15"/>`,
    textAt(barMm + 0.6, y, `${barMm} mm`),
    `</g>`,
  ].join('\n');
}

/** Wraps the SVG as a `SavedImage` ready to drop into the project. */
export function schematicSavedImage(
  graph: ChannelGraph,
  chipParams: ChipParams,
  label: string,
  options?: SvgExportOptions,
): SavedImage {
  const svg = exportSchematicSvg(graph, chipParams, { ...options, title: label });
  return {
    id: newId(),
    kind: 'schematic-svg',
    label,
    createdAt: new Date().toISOString(),
    mimeType: 'image/svg+xml',
    // Base64 rather than raw, so the data URI survives round-tripping through
    // JSON without escaping surprises.
    // `;charset=utf-8` keeps ⌀ and × from decoding as mojibake.
    data: `data:image/svg+xml;charset=utf-8;base64,${base64(svg)}`,
  };
}

function base64(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}
