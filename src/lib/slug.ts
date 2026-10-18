/**
 * A project name as a file-name stem: ASCII letters and digits joined by
 * hyphens, lower case. Falls back to "chip" when nothing usable is left, so an
 * export never downloads as ".stl".
 */
export function slugify(name: string): string {
  return (
    name
      .replace(/[^a-z0-9]+/gi, '-')
      .replace(/^-|-$/g, '')
      .toLowerCase() || 'chip'
  );
}
