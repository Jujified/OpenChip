/**
 * Handing a generated file to the user.
 *
 * Deliberately not the File System Access API: that is for the `.openchip`
 * project file, where writing back over the same file in place is the whole
 * point. An export is a fresh artifact every time, so a plain download is both
 * simpler and the behaviour every browser supports.
 */
/**
 * Hands over an image already held as a data URI.
 *
 * Saved images live inline in the project file as `data:` URIs, so there is no
 * blob to hand out until one is decoded. An `<a download>` pointed straight at
 * a multi-megabyte data URI is unreliable across browsers; decoding to a real
 * Blob first goes through the same path as every other export here.
 */
export function downloadDataUri(dataUri: string, filename: string): void {
  const comma = dataUri.indexOf(',');
  if (comma === -1) throw new Error('not a data URI');

  const header = dataUri.slice(0, comma);
  const payload = dataUri.slice(comma + 1);
  const mimeType = header.slice(5).split(';')[0] || 'application/octet-stream';

  if (!header.includes(';base64')) {
    downloadBlob(decodeURIComponent(payload), filename, mimeType);
    return;
  }

  const binary = atob(payload);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  downloadBlob(bytes, filename, mimeType);
}

export function downloadBlob(data: BlobPart, filename: string, mimeType: string): void {
  const url = URL.createObjectURL(new Blob([data], { type: mimeType }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  // Revoked on a delay rather than immediately: Safari has historically
  // cancelled an in-flight download when the object URL disappears under it.
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
