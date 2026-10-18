import assert from 'node:assert/strict';
import { describe, it } from 'vitest';
import { bytesFromDataUri, createZip, crc32, textEntry } from './zip';

/**
 * The archive is written by hand, so it is checked against the record layout
 * rather than against a library that would just be agreeing with itself. A ZIP
 * that opens in this test but not in Finder would be worse than no export at
 * all — the failure would surface on the user's machine, after the download.
 */
describe('zip writer', () => {
  const readU32 = (bytes: Uint8Array, at: number): number =>
    new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(at, true);
  const readU16 = (bytes: Uint8Array, at: number): number =>
    new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint16(at, true);

  it('matches the CRC32 of a known string', () => {
    // The standard check value for "123456789".
    assert.equal(crc32(new TextEncoder().encode('123456789')), 0xcbf43926);
    assert.equal(crc32(new Uint8Array(0)), 0);
  });

  it('writes local headers, a central directory and an end record', () => {
    const zip = createZip([textEntry('a.txt', 'hello'), textEntry('b/c.txt', 'world!')]);

    assert.equal(readU32(zip, 0), 0x04034b50, 'first local header signature');

    // The end-of-central-directory record is the last 22 bytes when there is no
    // archive comment, which is how a reader finds everything else.
    const endAt = zip.length - 22;
    assert.equal(readU32(zip, endAt), 0x06054b50, 'end of central directory signature');
    assert.equal(readU16(zip, endAt + 8), 2, 'entry count on this disk');
    assert.equal(readU16(zip, endAt + 10), 2, 'total entry count');

    const centralSize = readU32(zip, endAt + 12);
    const centralOffset = readU32(zip, endAt + 16);
    assert.equal(centralOffset + centralSize, endAt, 'central directory abuts the end record');
    assert.equal(readU32(zip, centralOffset), 0x02014b50, 'central header signature');
  });

  it('points every central header at a real local header', () => {
    const entries = [textEntry('one.txt', 'a'), textEntry('two.svg', '<svg/>')];
    const zip = createZip(entries);

    const endAt = zip.length - 22;
    let cursor = readU32(zip, endAt + 16);

    for (const entry of entries) {
      assert.equal(readU32(zip, cursor), 0x02014b50);
      const nameLength = readU16(zip, cursor + 28);
      const localOffset = readU32(zip, cursor + 42);

      assert.equal(readU32(zip, localOffset), 0x04034b50, `${entry.name} local header`);
      assert.equal(
        readU32(zip, cursor + 16),
        readU32(zip, localOffset + 14),
        `${entry.name} CRC agrees between headers`,
      );

      const name = new TextDecoder().decode(zip.subarray(cursor + 46, cursor + 46 + nameLength));
      assert.equal(name, entry.name);
      cursor += 46 + nameLength;
    }
  });

  it('stores content verbatim and flags names as UTF-8', () => {
    const contents = 'width ⌀0.8 mm × 0.5 mm';
    const zip = createZip([textEntry('note.txt', contents)]);
    const encoded = new TextEncoder().encode(contents);

    // Bit 11 set, so a reader decodes the name as UTF-8 rather than CP437.
    assert.equal(readU16(zip, 6) & 0x800, 0x800);
    // Stored, not deflated: sizes match and the bytes are the payload itself.
    assert.equal(readU16(zip, 8), 0, 'compression method is store');
    assert.equal(readU32(zip, 18), encoded.length, 'compressed size');
    assert.equal(readU32(zip, 22), encoded.length, 'uncompressed size');

    const nameLength = readU16(zip, 26);
    const start = 30 + nameLength;
    assert.deepEqual(zip.subarray(start, start + encoded.length), encoded);
  });

  it('clamps a pre-1980 timestamp instead of wrapping the DOS date', () => {
    const zip = createZip([textEntry('old.txt', 'x')], new Date('1970-01-01T00:00:00Z'));
    // Year field is the top 7 bits of the date word; 1980 encodes as 0.
    assert.equal(readU16(zip, 12) >> 9, 0);
  });

  it('round-trips base64 and plain data URIs', () => {
    assert.deepEqual(
      bytesFromDataUri('data:text/plain;base64,aGVsbG8='),
      new TextEncoder().encode('hello'),
    );
    assert.deepEqual(
      bytesFromDataUri('data:text/plain,hello%20there'),
      new TextEncoder().encode('hello there'),
    );
    assert.throws(() => bytesFromDataUri('not-a-data-uri'));
  });
});
