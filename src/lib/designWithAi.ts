/**
 * "Design with AI": the hand-off to an assistant that has the openchip-design
 * skill, and back.
 *
 * Nothing here touches the network. The dialog copies text, offers the skill as
 * a download built from files compiled into the app, and opens a link; the
 * user's description only leaves the machine when they choose to send it to an
 * assistant of their own.
 */

import type { PrinterProfile } from '../types/project';
import { createZip, textEntry } from './zip';

/** The one-line installer for coding agents (Claude Code, Codex, Cursor, …). */
export const SKILL_INSTALL_COMMAND = 'npx skills add Jujified/OpenChip';

/** Shown greyed in the empty description box, and cleared by typing. */
export const DESCRIPTION_PLACEHOLDER =
  'A serpentine mixer for two aqueous dyes at about 10 µL/min each, luer inlets, printed in two pieces.';

/** The skill's name, as its frontmatter declares it and as an agent invokes it. */
export const SKILL_NAME = 'openchip-design';

/**
 * The message handed to the assistant: the user's description, the printer it
 * has to print on, and one line naming the skill and the file to come back.
 *
 * The printer goes in because the skill would otherwise have to ask for it, and
 * the minimum feature size decides which channel sizes are safe at all.
 */
export function buildDesignPrompt(description: string, printer: PrinterProfile): string {
  const wanted = description.trim() || DESCRIPTION_PLACEHOLDER;
  const { buildVolumeMm: v } = printer;
  return [
    wanted,
    '',
    `My printer: ${printer.name} — ${printer.xyResolutionMicrons} µm XY, ` +
      `${printer.layerHeightMicrons} µm layers, ${printer.minFeatureSizeMm} mm minimum feature, ` +
      `${v.x} × ${v.y} × ${v.z} mm build volume.`,
    '',
    `Use the ${SKILL_NAME} skill and give me a .openchip file I can open in OpenChip.`,
  ].join('\n');
}

/** A new Claude conversation with the prompt already in the message box. */
export function claudeUrl(prompt: string): string {
  return `https://claude.ai/new?q=${encodeURIComponent(prompt)}`;
}

/**
 * Every file of the skill, as raw text, loaded only when someone asks for the
 * download — so the ~140 kB of skill does not ride along in the main bundle.
 */
const SKILL_FILES = import.meta.glob('../../skills/openchip-design/**/*', {
  query: '?raw',
  import: 'default',
}) as Record<string, () => Promise<string>>;

const SKILL_ROOT = '../../skills/openchip-design/';

/**
 * The skill as a `.zip` with a single `openchip-design/` folder at its root,
 * which is the shape skill uploads expect.
 */
export async function buildSkillZip(): Promise<Uint8Array<ArrayBuffer>> {
  const entries = await Promise.all(
    Object.entries(SKILL_FILES)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(async ([path, load]) =>
        textEntry(`${SKILL_NAME}/${path.slice(SKILL_ROOT.length)}`, await load()),
      ),
  );
  return createZip(entries);
}
