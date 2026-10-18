/**
 * Runs every check and returns one ranked list.
 *
 * There is deliberately no `isValid`, no `blockingErrors`, and no way for a
 * caller to ask "may I export?" — OpenChip never gates on validation, and
 * the cheapest way to keep that true is to never expose the shape that would
 * make gating easy to write.
 */

import {
  checkBoundaryClearance,
  checkBuildVolume,
  checkChannelSpacing,
  checkMinimumFeature,
  checkPortOverhangs,
} from './manufacturability';
import { checkConnectivity, checkDeadEnds, checkTaperRatio } from './flow';
import {
  checkChannelsUnderSlide,
  checkPortsUnderSlide,
  checkRoundChannelsUnderSlide,
  checkSlideFits,
} from './slide';
import { checkDrainage } from './drainage';
import { DEFAULT_VALIDATION_SETTINGS, summarise } from './types';
import type { ValidationResult, ValidationSettings } from './types';
import type { ChannelGraph, ChipParams, DrainageVent, PrinterProfile } from '../../types/project';

export * from './types';
export {
  checkBoundaryClearance,
  checkBuildVolume,
  checkChannelSpacing,
  checkMinimumFeature,
  checkPortOverhangs,
} from './manufacturability';
export { checkConnectivity, checkDeadEnds, checkTaperRatio, connectedComponents } from './flow';
export {
  checkChannelsUnderSlide,
  checkPortsUnderSlide,
  checkRoundChannelsUnderSlide,
  checkSlideFits,
} from './slide';
export {
  checkDrainage,
  distanceToOpening,
  enclosureState,
  findDrainagePoints,
  liveVents,
  planDrainage,
  ventsForPoints,
  DEFAULT_VENT_DIAMETER_MM,
} from './drainage';

export interface RunValidationInput {
  graph: ChannelGraph;
  chipParams: ChipParams;
  printerProfile: PrinterProfile;
  drainageVents?: DrainageVent[];
  settings?: ValidationSettings;
}

export function runValidation(input: RunValidationInput): ValidationResult {
  const settings = input.settings ?? DEFAULT_VALIDATION_SETTINGS;
  const base = {
    graph: input.graph,
    chipParams: input.chipParams,
    printerProfile: input.printerProfile,
    settings,
  };

  // An empty design is not a problem to be reported at — it is a blank page.
  // The slide pocket is the exception: it is a property of the chip rather than
  // of the design, and "that slide will not fit this chip" is worth knowing
  // before you draw anything into it.
  if (input.graph.nodes.length === 0 && input.graph.edges.length === 0) {
    return summarise([...checkBuildVolume(base), ...checkSlideFits(base)]);
  }

  return summarise([
    ...checkMinimumFeature(base),
    ...checkBoundaryClearance(base),
    ...checkChannelSpacing(base),
    ...checkBuildVolume(base),
    ...checkPortOverhangs(base),
    ...checkDeadEnds(base),
    ...checkConnectivity(base),
    ...checkTaperRatio(base),
    ...checkSlideFits(base),
    ...checkPortsUnderSlide(base),
    ...checkChannelsUnderSlide(base),
    ...checkRoundChannelsUnderSlide(base),
    ...checkDrainage({ ...base, vents: input.drainageVents ?? [] }),
  ]);
}
