/**
 * Shared fixtures for the print-correction tests. Not imported by the app.
 */

import { DEFAULT_CHIP_PARAMS, FALLBACK_PRINTER_PROFILE } from '../defaults';
import type { ChannelGraph, ChipParams } from '../../types/project';
import type { NominalDesign } from './compensate';
import { DFM_MODEL_ID, DFM_PROFILE_KIND, DFM_SCHEMA_VERSION, type DfmProfile } from './profile';

export function makeProfile(
  compensation: Partial<DfmProfile['compensation']> = {},
  meta: Partial<DfmProfile['meta']> = {},
): DfmProfile {
  return {
    kind: DFM_PROFILE_KIND,
    schemaVersion: DFM_SCHEMA_VERSION,
    meta: {
      name: 'Bench printer, clear resin',
      printerModel: 'Standard 4K',
      resin: 'Clear',
      layerHeightMicrons: 50,
      exposure: { normalExposureS: 2.5, bottomExposureS: 30, bottomLayers: 5, other: '' },
      xyPixelMicrons: 35,
      createdAt: '2026-01-15T10:00:00.000Z',
      notes: '',
      ...meta,
    },
    compensation: {
      model: DFM_MODEL_ID,
      deltaXyMm: 0.05,
      lateralDecayMm: 0,
      deltaZMm: 0.1,
      snapToPixelGrid: false,
      ...compensation,
    },
    fit: {
      lateral: { method: 'manual', dataPoints: 0 },
      vertical: { method: 'manual', dataPoints: 0 },
    },
    coupon: { version: 1, widthsMm: [0.2, 0.4], heightsMm: [0.2, 0.4] },
    measurements: [
      { id: '1.1', nominalWidthMm: 0.4, nominalHeightMm: 0.2, result: 'open' },
      { id: '1.2', nominalWidthMm: 0.2, nominalHeightMm: 0.2, result: 'closed', measuredWidthMm: 0 },
    ],
  };
}

/** Two straight parallel channels along X, `pitchMm` apart centre to centre. */
export function parallelChannels(pitchMm: number): ChannelGraph {
  return {
    nodes: [
      { id: 'a1', x: 10, y: 20, type: 'waypoint' },
      { id: 'a2', x: 30, y: 20, type: 'waypoint' },
      { id: 'b1', x: 10, y: 20 + pitchMm, type: 'waypoint' },
      { id: 'b2', x: 30, y: 20 + pitchMm, type: 'waypoint' },
    ],
    edges: [
      {
        id: 'ea',
        fromNodeId: 'a1',
        toNodeId: 'a2',
        curveType: 'straight',
        crossSection: 'rect',
        dimensionPoints: [],
      },
      {
        id: 'eb',
        fromNodeId: 'b1',
        toNodeId: 'b2',
        curveType: 'straight',
        crossSection: 'rect',
        dimensionPoints: [],
      },
    ],
  };
}

export function design(graph: ChannelGraph, chipParams: Partial<ChipParams> = {}): NominalDesign {
  return {
    graph,
    chipParams: { ...DEFAULT_CHIP_PARAMS, ...chipParams },
    drainageVents: [],
    printerProfile: FALLBACK_PRINTER_PROFILE,
  };
}
