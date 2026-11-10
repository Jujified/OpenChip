/**
 * What an export is built from, and what it is called.
 *
 * Every STL and OpenSCAD export goes through `planExport`. With no profile it
 * hands back the nominal design untouched — the same objects, an empty suffix,
 * the same header the app has always written — so "None (uncompensated)" is not
 * a special mode of this feature but its absence. With a profile it runs
 * `compensateDesign` and names the result so it cannot be mistaken for the
 * nominal file.
 */

import { slugify } from '../slug';
import { compensateDesign, type CompensatedDesign, type NominalDesign } from './compensate';
import { shortHash, type DfmProfile } from './profile';
import type { ChannelGraph, ChipParams, DrainageVent } from '../../types/project';

/** A loaded profile with the hash of its contents. */
export interface DfmEntry {
  profile: DfmProfile;
  sha256: string;
}

export interface ExportPlan {
  graph: ChannelGraph;
  chipParams: ChipParams;
  drainageVents: DrainageVent[];
  ceilingRaiseMm: number;
  /** Appended to the file stem: empty for a nominal export. */
  fileSuffix: string;
  /** The 80-byte STL header. */
  stlHeader: string;
  /** Comment lines for the top of the OpenSCAD source. */
  scadNotes: string[];
  /** The full result of compensation, or null for a nominal export. */
  compensated: CompensatedDesign | null;
}

const mm = (value: number): string => String(Number(value.toFixed(4)));

export function planExport(
  nominal: NominalDesign,
  projectName: string,
  entry: DfmEntry | null,
  compensated?: CompensatedDesign,
): ExportPlan {
  if (!entry) {
    return {
      graph: nominal.graph,
      chipParams: nominal.chipParams,
      drainageVents: nominal.drainageVents,
      ceilingRaiseMm: 0,
      fileSuffix: '',
      stlHeader: `OpenChip ${projectName}`,
      scadNotes: [],
      compensated: null,
    };
  }

  const { profile, sha256 } = entry;
  const result = compensated ?? compensateDesign(nominal, profile);
  const { applied } = result;

  return {
    graph: result.graph,
    chipParams: result.chipParams,
    drainageVents: result.drainageVents,
    ceilingRaiseMm: result.ceilingRaiseMm,
    fileSuffix: `-dfm-${slugify(profile.meta.name)}`,
    // An STL header is 80 bytes and nothing else in the format carries
    // metadata, so the hash goes first where truncation cannot reach it.
    stlHeader: `OpenChip DFM ${shortHash(sha256)} ${profile.meta.name} | ${projectName}`,
    scadNotes: [
      '',
      'PRINT-CORRECTED GEOMETRY — not the nominal design.',
      `Print-correction profile: ${profile.meta.name}`,
      `Profile SHA-256: ${sha256}`,
      `Lateral offset per side: ${mm(applied.deltaXyMm)} mm` +
        (applied.lateralDecayMm > 0 ? `, decay length ${mm(applied.lateralDecayMm)} mm` : ''),
      applied.deltaZMm > 0
        ? `Ceiling raise: ${mm(applied.deltaZMm)} mm`
        : 'Ceiling raise: none (no printed ceilings on this split type)',
      'Channel sizes below already include the correction. Ports are nominal.',
    ],
    compensated: result,
  };
}
