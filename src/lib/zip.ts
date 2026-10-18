/**
 * A minimal, store-only ZIP writer.
 *
 * Hand-written rather than pulled from npm because the whole requirement is
 * "put these four files in one download". Compression would buy nothing — the
 * payload is already-compressed PNGs plus a little SVG text — so the deflate
 * half of a zip library is dead weight, and a 40 kB dependency in a
 * no-backend app that has to work offline is a real cost for a format that is
 * three fixed-layout records.
 *
 * Everything is stored (method 0) and the UTF-8 name flag is set, so filenames
 * with a degree sign survive on every platform.
 */

export interface ZipEntry {
  /** Path inside the archive. Forward slashes only. */
  name: string;
  data: Uint8Array;
}

// ---------------------------------------------------------------------------
// CRC32
// ---------------------------------------------------------------------------

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let bit = 0; bit < 8; bit += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[i] = c >>> 0;
  }
  return table;
})();

export function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i += 1) {
    crc = CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

// ---------------------------------------------------------------------------
// writing
// ---------------------------------------------------------------------------

/** MS-DOS packed date and time, which is what the format stores. */
function dosDateTime(date: Date): { time: number; date: number } {
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | (Math.floor(date.getSeconds() / 2)),
    // The DOS epoch is 1980; a year before that cannot be represented, so it is
    // clamped rather than allowed to wrap into a nonsense date.
    date:
      ((Math.max(1980, date.getFullYear()) - 1980) << 9) |
      ((date.getMonth() + 1) << 5) |
      date.getDate(),
  };
}

const LOCAL_HEADER_SIG = 0x04034b50;
const CENTRAL_HEADER_SIG = 0x02014b50;
const END_OF_CENTRAL_SIG = 0x06054b50;
/** Bit 11: filenames and comments are UTF-8. */
const UTF8_FLAG = 0x800;

// `Uint8Array<ArrayBuffer>` rather than plain `Uint8Array`: the default type
// parameter admits a SharedArrayBuffer, which `Blob` will not accept, so being
// specific here is what lets the result go straight to a download.
export function createZip(entries: ZipEntry[], now = new Date()): Uint8Array<ArrayBuffer> {
  const encoder = new TextEncoder();
  const stamp = dosDateTime(now);

  const prepared = entries.map((entry) => ({
    nameBytes: encoder.encode(entry.name),
    data: entry.data,
    crc: crc32(entry.data),
  }));

  const localSize = prepared.reduce((sum, e) => sum + 30 + e.nameBytes.length + e.data.length, 0);
  const centralBytes = prepared.reduce((sum, e) => sum + 46 + e.nameBytes.length, 0);

  const out = new Uint8Array(localSize + centralBytes + 22);
  const view = new DataView(out.buffer);
  let offset = 0;

  const u16 = (value: number) => {
    view.setUint16(offset, value, true);
    offset += 2;
  };
  const u32 = (value: number) => {
    view.setUint32(offset, value >>> 0, true);
    offset += 4;
  };
  const bytes = (value: Uint8Array) => {
    out.set(value, offset);
    offset += value.length;
  };

  const localOffsets: number[] = [];

  for (const entry of prepared) {
    localOffsets.push(offset);
    u32(LOCAL_HEADER_SIG);
    u16(20); // version needed
    u16(UTF8_FLAG);
    u16(0); // stored
    u16(stamp.time);
    u16(stamp.date);
    u32(entry.crc);
    u32(entry.data.length);
    u32(entry.data.length);
    u16(entry.nameBytes.length);
    u16(0); // extra field length
    bytes(entry.nameBytes);
    bytes(entry.data);
  }

  const centralStart = offset;

  prepared.forEach((entry, index) => {
    u32(CENTRAL_HEADER_SIG);
    u16(20); // version made by
    u16(20); // version needed
    u16(UTF8_FLAG);
    u16(0); // stored
    u16(stamp.time);
    u16(stamp.date);
    u32(entry.crc);
    u32(entry.data.length);
    u32(entry.data.length);
    u16(entry.nameBytes.length);
    u16(0); // extra
    u16(0); // comment
    u16(0); // disk number
    u16(0); // internal attributes
    u32(0); // external attributes
    u32(localOffsets[index]);
    bytes(entry.nameBytes);
  });

  // Captured before the end record starts consuming `offset`, which would
  // otherwise fold its own first twelve bytes into the reported size.
  const centralSize = offset - centralStart;

  u32(END_OF_CENTRAL_SIG);
  u16(0); // this disk
  u16(0); // disk with central directory
  u16(prepared.length);
  u16(prepared.length);
  u32(centralSize);
  u32(centralStart);
  u16(0); // comment length

  return out;
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

export const textEntry = (name: string, contents: string): ZipEntry => ({
  name,
  data: new TextEncoder().encode(contents),
});

/** Decodes a `data:...;base64,...` URI into raw bytes. */
export function bytesFromDataUri(dataUri: string): Uint8Array {
  const comma = dataUri.indexOf(',');
  if (comma === -1) throw new Error('Not a data URI');

  const payload = dataUri.slice(comma + 1);
  if (!/;base64/i.test(dataUri.slice(0, comma))) {
    return new TextEncoder().encode(decodeURIComponent(payload));
  }

  const binary = atob(payload);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
  return out;
}
