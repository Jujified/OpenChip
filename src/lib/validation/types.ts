/**
 * The validation model.
 *
 * OpenChip is absolute on one point: a warning never blocks anything. So a
 * `Warning` carries no "valid" flag, no "canExport" boolean, and no severity
 * level that means "stop". Severity ranks how likely the user is to regret
 * ignoring it, and nothing else. The UI is free to sort and colour by it; it is
 * not free to gate on it.
 *
 * Every warning names the elements it is about, which is what makes the panel
 * clickable and lets both the 2D canvas and the 3D viewport highlight the same
 * thing.
 */

import type { ChannelGraph, ChipParams, PrinterProfile, Point2 } from '../../types/project';

export type Severity = 'risk' | 'caution' | 'info';

/** Ordering for display: worst first. */
export const SEVERITY_ORDER: Record<Severity, number> = { risk: 0, caution: 1, info: 2 };

export const SEVERITY_LABEL: Record<Severity, string> = {
  risk: 'Risk',
  caution: 'Caution',
  info: 'Info',
};

/**
 * Stable identifiers for each kind of check.
 *
 * Kept as a union rather than free strings so the UI can group, and so a check
 * cannot silently rename itself out of a user's muted list later.
 */
export type WarningKind =
  // manufacturability
  | 'channel-below-min-feature'
  | 'channel-near-boundary'
  | 'channels-too-close'
  | 'channels-overlap'
  | 'footprint-exceeds-build-volume'
  | 'port-overhang'
  | 'port-protrusion'
  | 'thread-support'
  // flow feasibility
  | 'dead-end-channel'
  | 'disconnected-network'
  | 'no-ports'
  | 'abrupt-taper'
  // glass slide
  | 'slide-does-not-fit'
  | 'port-under-slide'
  | 'channel-outside-slide'
  | 'round-channel-under-slide'
  // drainage
  | 'enclosed-cavity'
  | 'undrained-region';

export interface WarningTarget {
  nodeIds: string[];
  edgeIds: string[];
  /**
   * Where to center the view when the user clicks through, in chip mm. Derived
   * from the targets when a check does not set it explicitly.
   */
  focus?: Point2;
}

export interface Warning {
  /** Stable across re-runs for the same offending element, so focus survives. */
  id: string;
  kind: WarningKind;
  severity: Severity;
  /** One line, naming the problem in the user's terms. */
  title: string;
  /** What the consequence is, and what to do about it. */
  detail: string;
  /** The measured value that triggered it, for the numeric readout. */
  measurement?: { value: number; limit: number; unit: string };
  target: WarningTarget;
}

export interface ValidationInput {
  graph: ChannelGraph;
  chipParams: ChipParams;
  printerProfile: PrinterProfile;
  settings: ValidationSettings;
}

export interface ValidationSettings {
  /**
   * Width ratio between consecutive dimension markers above which a taper is
   * flagged. Configurable because what counts as abrupt depends entirely on
   * what the chip is for.
   */
  taperRatioThreshold: number;
  /**
   * Smallest wall between two channels that a resin printer will hold, mm.
   * Distinct from `minEdgeSpacing`, which is the user's own design rule for
   * the chip boundary.
   */
  minPrintableWallMm: number;
  /** Overhang angle from vertical, in degrees, above which supports are likely. */
  overhangLimitDeg: number;
}

export const DEFAULT_VALIDATION_SETTINGS: ValidationSettings = {
  taperRatioThreshold: 2,
  // Thin walls between channels are the classic resin failure: they cure
  // through and the two channels merge into one.
  minPrintableWallMm: 0.4,
  overhangLimitDeg: 45,
};

export interface ValidationResult {
  warnings: Warning[];
  counts: Record<Severity, number>;
}

export function summarise(warnings: Warning[]): ValidationResult {
  const counts: Record<Severity, number> = { risk: 0, caution: 0, info: 0 };
  for (const warning of warnings) counts[warning.severity] += 1;

  const sorted = [...warnings].sort(
    (a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity],
  );

  return { warnings: sorted, counts };
}
