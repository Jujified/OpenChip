/**
 * The one map from in-app context to wiki anchors.
 *
 * This file is why the wiki is worth having. A researcher who sees
 * *"Only 0.3 mm of wall between two channels"* should be one quiet click from
 * the explanation of why resin cures through thin walls — not left to search a
 * documentation site for a phrase they half-remember.
 *
 * ## Two rules
 *
 * **Every link lives here.** `npm run wiki:audit` reads this file, resolves
 * every path against the built wiki, and fails if a page or an anchor is
 * missing. Scattering `href`s through components would make that impossible,
 * and a dead "Learn more" link is worse than no link: it tells the reader the
 * explanation exists and then loses it.
 *
 * **The anchors are an API.** Renaming a heading in the wiki breaks an in-app
 * link. Do it deliberately, and change the path here in the same commit.
 *
 * ## The frequency gate
 *
 * These render as quiet inline links, never as buttons, and they never animate.
 * A warning row is something a user scans past dozens of times in a session;
 * anything that draws the eye there is a tax rather than an affordance.
 */

import { wikiUrl } from './siteUrls';
import type { WarningKind } from './validation/types';

/**
 * Every design check, anchored on its own id.
 *
 * The `Record<WarningKind, string>` is load-bearing: adding a member to the
 * union without adding a link here is a type error, so a new check cannot ship
 * undocumented. The audit then checks the other direction — that the anchor
 * actually exists in the wiki.
 */
export const WARNING_LINKS: Record<WarningKind, string> = {
  'channel-below-min-feature': '/reference/design-checks/#channel-below-min-feature',
  'channel-near-boundary': '/reference/design-checks/#channel-near-boundary',
  'channels-too-close': '/reference/design-checks/#channels-too-close',
  'channels-overlap': '/reference/design-checks/#channels-overlap',
  'footprint-exceeds-build-volume': '/reference/design-checks/#footprint-exceeds-build-volume',
  'port-overhang': '/reference/design-checks/#port-overhang',
  'port-protrusion': '/reference/design-checks/#port-protrusion',
  'thread-support': '/reference/design-checks/#thread-support',
  'slide-does-not-fit': '/reference/design-checks/#slide-does-not-fit',
  'port-under-slide': '/reference/design-checks/#port-under-slide',
  'channel-outside-slide': '/reference/design-checks/#channel-outside-slide',
  'round-channel-under-slide': '/reference/design-checks/#round-channel-under-slide',
  'dead-end-channel': '/reference/design-checks/#dead-end-channel',
  'disconnected-network': '/reference/design-checks/#disconnected-network',
  'no-ports': '/reference/design-checks/#no-ports',
  'abrupt-taper': '/reference/design-checks/#abrupt-taper',
  'enclosed-cavity': '/reference/design-checks/#enclosed-cavity',
  'undrained-region': '/reference/design-checks/#undrained-region',
};

/** Everywhere else in the app that has something to point at. */
export const CONTEXT_LINKS = {
  /** Onboarding's printer-profile step, and Settings → Printer. */
  printerProfile: '/printing/choosing-a-printer/',
  /** The Fluid Dynamics tab header. */
  fluidDynamics: '/concepts/limits-of-analytical-estimates/',
  /** The monolithic / two-piece control in the CAD panel. */
  splitType: '/printing/monolithic-vs-two-piece/',
  /** The export dialog and the CAD panel's export block. */
  exporting: '/guide/exporting/',
  /** The drainage-vent planner. */
  drainage: '/printing/draining-uncured-resin/',
  /** The Design checks panel header. */
  designChecks: '/guide/design-checks/',
  /** The keyboard shortcut sheet. */
  shortcuts: '/reference/keyboard-shortcuts/',
  /** The Library tab. */
  templates: '/guide/templates/',
  /** Save / open, and the `.openchip` format itself. */
  fileFormat: '/reference/file-format/',
  /** The dimension tool. */
  dimensionMarkers: '/guide/dimension-markers/',
} as const;

export type ContextLink = keyof typeof CONTEXT_LINKS;

/** Absolute URL for a warning's explanation. */
export const warningHelpUrl = (kind: WarningKind): string => wikiUrl(WARNING_LINKS[kind]);

/** Absolute URL for a named in-app context. */
export const contextHelpUrl = (key: ContextLink): string => wikiUrl(CONTEXT_LINKS[key]);

/**
 * A template's section on the Templates page.
 *
 * Not in `CONTEXT_LINKS` because the id comes from the preset library at
 * runtime; the audit checks the Templates page has an anchor for every preset
 * separately.
 */
export const presetHelpUrl = (presetId: string): string =>
  wikiUrl(`/guide/templates/#${presetId}`);
