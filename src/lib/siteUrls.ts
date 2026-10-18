/**
 * The three surfaces, resolved from the environment.
 *
 * Never hardcode a domain in a component — every cross-surface link in the app
 * comes from here, so changing a domain later is one edit in three files:
 * this one, `landing/src/lib/urls.mjs`, and `wiki/src/lib/urls.mjs`.
 *
 * ## Why the fallbacks are conditional
 *
 * Local dev has to work without a `.env`, but falling back to localhost
 * unconditionally would mean a forgotten Vercel environment variable ships a
 * production build whose Help menu points at a machine that isn't yours. So dev
 * falls back to localhost and everything else falls back to the real domains.
 */

const DEV = import.meta.env.DEV;

/** The marketing site. */
export const SITE_URL: string =
  import.meta.env.VITE_SITE_URL ?? (DEV ? 'http://localhost:4321' : 'https://openchip.tech');

/** The wiki. */
export const WIKI_URL: string =
  import.meta.env.VITE_WIKI_URL ?? (DEV ? 'http://localhost:4322' : 'https://wiki.openchip.tech');

/** Joins a wiki path onto the base without doubling or dropping a slash. */
export function wikiUrl(path: string): string {
  return `${WIKI_URL.replace(/\/$/, '')}/${path.replace(/^\//, '')}`;
}
