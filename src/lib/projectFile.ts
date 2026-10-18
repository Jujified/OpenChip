/**
 * `.openchip` serialisation, parsing, validation and migration.
 *
 * Deliberately free of React and of any storage mechanism — this module turns
 * text into a validated project and back. `fileAccess.ts` decides *where* that
 * text comes from or goes.
 */

import * as z from 'zod';
import { OPENCHIP_FORMAT_VERSION, type OpenChipProject } from '../types/project';
import { checkGraphIntegrity, describeIssues, projectSchema } from './schema';

export const OPENCHIP_EXTENSION = '.openchip';
export const OPENCHIP_MIME = 'application/json';

// ---------------------------------------------------------------------------
// result type
// ---------------------------------------------------------------------------

export interface ParseSuccess {
  ok: true;
  project: OpenChipProject;
  /** Non-fatal notes worth showing the user, e.g. a forward-version file. */
  warnings: string[];
}

export interface ParseFailure {
  ok: false;
  /** One-line summary for a toast or dialog heading. */
  message: string;
  /** Specific, actionable problems. May be empty. */
  details: string[];
}

export type ParseResult = ParseSuccess | ParseFailure;

// ---------------------------------------------------------------------------
// serialise
// ---------------------------------------------------------------------------

/**
 * Returns the project as it should be written: current format version, and
 * `modifiedAt` set to now.
 *
 * Split out from `serializeProject` so a caller can put the *same* stamped
 * object into both the file and the store. Stamping inside the serialiser
 * meant memory and disk disagreed by however many milliseconds the write took.
 */
export function stampForSave(project: OpenChipProject): OpenChipProject {
  return {
    ...project,
    formatVersion: OPENCHIP_FORMAT_VERSION,
    meta: { ...project.meta, modifiedAt: new Date().toISOString() },
  };
}

/** Pretty-printed JSON — diff-friendly if the user keeps projects in git. */
export function serializeProject(project: OpenChipProject): string {
  return `${JSON.stringify(project, null, 2)}\n`;
}

/** Filesystem-safe filename derived from the project name. */
export function suggestedFileName(projectName: string): string {
  const base = projectName
    .trim()
    .replace(/[^a-zA-Z0-9-_ ]+/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60);
  return `${base || 'untitled-chip'}${OPENCHIP_EXTENSION}`;
}

// ---------------------------------------------------------------------------
// migrate
// ---------------------------------------------------------------------------

/**
 * Upgrades an older file in place. Every file so far is version 1, so there is
 * nothing to do yet — the hook exists so later versions have an obvious place to add steps
 * instead of scattering `if (formatVersion < n)` through the loader.
 */
function migrate(raw: Record<string, unknown>): { data: Record<string, unknown>; warnings: string[] } {
  const warnings: string[] = [];
  const version = typeof raw.formatVersion === 'number' ? raw.formatVersion : 0;

  if (version === 0) {
    warnings.push('This file had no version stamp — it was read as version 1.');
    raw = { ...raw, formatVersion: 1 };
  }

  if (version > OPENCHIP_FORMAT_VERSION) {
    warnings.push(
      `This file was saved by a newer version of OpenChip (format ${version}, this build reads ${OPENCHIP_FORMAT_VERSION}). ` +
        'It opened, but anything this build does not understand is preserved untouched rather than shown.',
    );
  }

  return { data: raw, warnings };
}

// ---------------------------------------------------------------------------
// parse
// ---------------------------------------------------------------------------

export function parseProject(text: string): ParseResult {
  if (text.trim().length === 0) {
    return { ok: false, message: 'That file is empty.', details: [] };
  }

  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    return {
      ok: false,
      message: "That file isn't valid JSON, so it can't be read as an OpenChip project.",
      details: [
        error instanceof Error ? error.message : String(error),
        'If you edited it by hand, check for a trailing comma or an unclosed brace.',
      ],
    };
  }

  return normaliseProject(raw);
}

/**
 * Everything `parseProject` does after the JSON parse: migrate, schema-parse
 * with defaults, check the graph holds together.
 *
 * Its own entry point so the browser draft goes through the same door as a
 * file. The draft is JSON the app wrote itself, but possibly by an older
 * build: a field added since (`drainageVents` and `fluidSetup` both were) or a
 * nested one (`slide.bondGapMm`) comes back missing, and trusting it as-is is
 * how a stale draft crashes the first component that reads the new field.
 */
export function normaliseProject(raw: unknown): ParseResult {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return {
      ok: false,
      message: "That file isn't an OpenChip project.",
      details: ['The file parsed as JSON, but it is not a project object.'],
    };
  }

  const { data, warnings } = migrate(raw as Record<string, unknown>);

  const result = projectSchema.safeParse(data);
  if (!result.success) {
    return {
      ok: false,
      message: "That file is missing or has invalid project data, so it wasn't opened.",
      details: describeIssues(result.error as z.ZodError),
    };
  }

  const project = result.data as unknown as OpenChipProject;

  const integrity = checkGraphIntegrity(project.channelGraph);
  if (integrity.length > 0) {
    return {
      ok: false,
      message: "That project's channel network is inconsistent, so it wasn't opened.",
      details: integrity.slice(0, 6),
    };
  }

  return { ok: true, project, warnings };
}
