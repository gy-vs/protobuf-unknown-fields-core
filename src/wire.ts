import { decodeVarint } from './varint.js';

/** Error thrown for any malformed wire data (truncation, bad groups, ...). */
export class WireError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WireError';
  }
}

export const WIRE_VARINT = 0;
export const WIRE_FIXED64 = 1;
export const WIRE_LENGTH_DELIMITED = 2;
export const WIRE_SGROUP = 3;
export const WIRE_EGROUP = 4;
export const WIRE_FIXED32 = 5;

/**
 * One wire record located inside a source buffer. Offsets refer to `source`.
 *
 * - key: the tag varint bytes only (`keyStart..keyEnd`)
 * - value: raw value bytes (`valStart..valEnd`) — for length-delimited fields
 *   this is the payload without the length prefix; the length varint lives in
 *   `lenStart..lenEnd`.
 * - for a group, `valStart..valEnd` is the body (excluding both tags) and
 *   `endKeyStart..endKeyEnd` covers the closing EGROUP tag.
 */
export interface RawEntry {
  field: number;
  wireType: number;
  keyStart: number;
  keyEnd: number;
  lenStart?: number;
  lenEnd?: number;
  valStart: number;
  valEnd: number;
  endKeyStart?: number;
  endKeyEnd?: number;
  source: Uint8Array;
  /**
   * Group nesting level: 0 for top-level records. A group start itself is
   * emitted at the level of its parent; its body records are one deeper.
   */
  depth?: number;
}

export function rawKey(e: RawEntry): Uint8Array {
  return e.source.subarray(e.keyStart, e.keyEnd);
}

export function rawValue(e: RawEntry): Uint8Array {
  return e.source.subarray(e.valStart, e.valEnd);
}

/** Full original bytes of this record (a group includes both tags). */
export function rawRecord(e: RawEntry): Uint8Array {
  const end = e.wireType === WIRE_SGROUP ? e.endKeyEnd ?? e.valEnd : e.valEnd;
  return e.source.subarray(e.keyStart, end);
}

interface ScanResult {
  entries: RawEntry[];
  /** Offset of the EGROUP tag (groups only). */
  endKeyStart?: number;
  /** Position just past the EGROUP tag (groups) or end of range. */
  endPos: number;
}

function readTag(
  source: Uint8Array,
  p: number,
  end: number,
): { field: number; wireType: number; tagEnd: number; tagStart: number } {
  const tagStart = p;
  const tag = decodeVarint(source, p);
  if (!tag || p + tag.length > end) {
    throw new WireError(`truncated or invalid field tag at offset ${tagStart}`);
  }
  const tagValue = Number(tag.value);
  const wireType = tagValue & 0x7;
  const field = tagValue >>> 3;
  // Note: wire type 4 (EGROUP) is legal syntactically and must be parsed so
  // the group scanner can match it; it is handled by the caller. Types 6/7 are
  // reserved and always illegal.
  if (field === 0 && wireType !== 4) {
    throw new WireError(`invalid field number 0 at offset ${tagStart}`);
  }
  if (wireType > 5) {
    throw new WireError(
      `reserved/unsupported wire type ${wireType} at offset ${tagStart}`,
    );
  }
  return { field, wireType, tagEnd: p + tag.length, tagStart };
}

/**
 * Recursive scanner. When `groupField` is non-null, the first EGROUP at this
 * nesting level must carry that same field number and closes the range.
 * Records are returned as a flat list with `depth` annotations: a group
 * start sits at its parent's depth, its body records one deeper.
 */
function scan(
  source: Uint8Array,
  start: number,
  end: number,
  groupField: number | null,
  depth: number,
): ScanResult {
  const entries: RawEntry[] = [];
  let p = start;

  while (p < end) {
    const { field, wireType, tagEnd, tagStart } = readTag(source, p, end);
    p = tagEnd;

    if (wireType === WIRE_EGROUP) {
      if (groupField === null) {
        throw new WireError(`unexpected group end tag for field ${field}`);
      }
      if (field !== groupField) {
        throw new WireError(
          `group end tag field ${field} does not match start tag field ${groupField}`,
        );
      }
      return { entries, endKeyStart: tagStart, endPos: p };
    }

    if (wireType === WIRE_VARINT) {
      const v = decodeVarint(source, p);
      if (!v || p + v.length > end) {
        throw new WireError(`truncated varint value for field ${field}`);
      }
      entries.push({
        field, wireType, keyStart: tagStart, keyEnd: tagEnd,
        valStart: p, valEnd: p + v.length, source, depth,
      });
      p += v.length;
    } else if (wireType === WIRE_FIXED64) {
      if (p + 8 > end) throw new WireError(`truncated fixed64 for field ${field}`);
      entries.push({
        field, wireType, keyStart: tagStart, keyEnd: tagEnd,
        valStart: p, valEnd: p + 8, source, depth,
      });
      p += 8;
    } else if (wireType === WIRE_FIXED32) {
      if (p + 4 > end) throw new WireError(`truncated fixed32 for field ${field}`);
      entries.push({
        field, wireType, keyStart: tagStart, keyEnd: tagEnd,
        valStart: p, valEnd: p + 4, source, depth,
      });
      p += 4;
    } else if (wireType === WIRE_LENGTH_DELIMITED) {
      const lenVar = decodeVarint(source, p);
      if (!lenVar || p + lenVar.length > end) {
        throw new WireError(`truncated length for field ${field}`);
      }
      const len = Number(lenVar.value);
      const valStart = p + lenVar.length;
      if (valStart + len > end) {
        throw new WireError(`length-delimited field ${field} exceeds its range`);
      }
      entries.push({
        field, wireType, keyStart: tagStart, keyEnd: tagEnd,
        lenStart: p, lenEnd: valStart, valStart, valEnd: valStart + len, source, depth,
      });
      p = valStart + len;
    } else {
      // WIRE_SGROUP
      const bodyStart = p;
      const inner = scan(source, bodyStart, end, field, depth + 1);
      entries.push({
        field, wireType, keyStart: tagStart, keyEnd: tagEnd,
        valStart: bodyStart, valEnd: inner.endKeyStart!,
        endKeyStart: inner.endKeyStart, endKeyEnd: inner.endPos,
        source, depth,
      });
      for (const e of inner.entries) entries.push(e);
      p = inner.endPos;
    }
  }

  if (groupField !== null) {
    throw new WireError(`unterminated group for field ${groupField}`);
  }
  return { entries, endPos: end };
}

/** Split a message buffer into raw records in wire order. */
export function scanMessage(source: Uint8Array): RawEntry[] {
  const result = scan(source.slice(), 0, source.length, null, 0);
  return result.entries;
}
