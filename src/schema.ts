import {
  WIRE_FIXED32, WIRE_FIXED64, WIRE_LENGTH_DELIMITED, WIRE_SGROUP, WIRE_VARINT,
  type RawEntry, WireError, rawValue,
} from './wire.js';
import { decodeVarint, encodeVarint } from './varint.js';
import { Writer } from './writer.js';

/** Supported schema scalar/enum value types. */
export type ScalarType =
  | 'double' | 'float'
  | 'int32' | 'int64' | 'uint32' | 'uint64'
  | 'sint32' | 'sint64'
  | 'fixed32' | 'fixed64' | 'sfixed32' | 'sfixed64'
  | 'bool' | 'string' | 'bytes' | 'enum';

export interface FieldSchema {
  number: number;
  type: ScalarType | 'message' | 'group';
  repeated?: boolean;
  /** Repeated numeric fields serialize packed by default in proto3; off by default in proto2. */
  packed?: boolean;
  /** Schema of the embedded message (type 'message' only). */
  schema?: Schema;
}

/** Either a map keyed by field number or a list of field schemas. */
export type Schema = Map<number, FieldSchema> | FieldSchema[];

export function normalizeSchema(schema?: Schema): Map<number, FieldSchema> {
  if (!schema) return new Map();
  if (schema instanceof Map) return schema;
  const m = new Map<number, FieldSchema>();
  for (const f of schema) m.set(f.number, f);
  return m;
}

// ---------------------------------------------------------------------------
// Scalar wire classification
// ---------------------------------------------------------------------------

export function scalarWire(type: ScalarType): number {
  switch (type) {
    case 'double':
    case 'fixed64':
    case 'sfixed64':
      return WIRE_FIXED64;
    case 'float':
    case 'fixed32':
    case 'sfixed32':
      return WIRE_FIXED32;
    case 'string':
    case 'bytes':
      return WIRE_LENGTH_DELIMITED;
    default:
      return WIRE_VARINT;
  }
}

export function isPackable(type: FieldSchema['type']): boolean {
  return type !== 'message' && type !== 'group'
    && type !== 'string' && type !== 'bytes';
}

export function acceptableWire(schema: FieldSchema): number[] {
  if (schema.type === 'message') return [WIRE_LENGTH_DELIMITED];
  if (schema.type === 'group') return [WIRE_SGROUP];
  const w = scalarWire(schema.type);
  // Repeated packable fields may appear packed (length-delimited) or unpacked
  // (element wire type) regardless of the declared packing preference.
  if (schema.repeated && isPackable(schema.type)) {
    return [w, WIRE_LENGTH_DELIMITED];
  }
  return [w];
}

// ---------------------------------------------------------------------------
// Scalar value decoding
// ---------------------------------------------------------------------------

const td = new TextDecoder('utf-8', { fatal: true });
const te = new TextEncoder();

export function decodeScalar(type: ScalarType, entry: RawEntry): string | number | bigint | boolean | Uint8Array {
  const v = rawValue(entry);
  switch (type) {
    case 'double': {
      if (v.length !== 8) throw new WireError('double requires 8 bytes');
      return new DataView(v.buffer, v.byteOffset, 8).getFloat64(0, true);
    }
    case 'float': {
      if (v.length !== 4) throw new WireError('float requires 4 bytes');
      return new DataView(v.buffer, v.byteOffset, 4).getFloat32(0, true);
    }
    case 'fixed32': {
      if (v.length !== 4) throw new WireError('fixed32 requires 4 bytes');
      return new DataView(v.buffer, v.byteOffset, 4).getUint32(0, true);
    }
    case 'sfixed32': {
      if (v.length !== 4) throw new WireError('sfixed32 requires 4 bytes');
      return new DataView(v.buffer, v.byteOffset, 4).getInt32(0, true);
    }
    case 'fixed64': {
      if (v.length !== 8) throw new WireError('fixed64 requires 8 bytes');
      return new DataView(v.buffer, v.byteOffset, 8).getBigUint64(0, true);
    }
    case 'sfixed64': {
      if (v.length !== 8) throw new WireError('sfixed64 requires 8 bytes');
      return new DataView(v.buffer, v.byteOffset, 8).getBigInt64(0, true);
    }
    case 'bool': {
      // proto: any non-zero varint is true
      let n = 0n;
      for (let i = 0; i < v.length; i++) n |= BigInt(v[i] & 0x7f) << BigInt(7 * i);
      return n !== 0n;
    }
    case 'string':
      try {
        return td.decode(v);
      } catch {
        throw new WireError('invalid UTF-8 in string field');
      }
    case 'bytes':
      return v.slice();
    case 'enum':
    case 'uint32':
      return Number(readVarintValue(entry) & 0xffffffffn) >>> 0;
    case 'int32':
    case 'sint32': {
      let n = Number(BigInt.asIntN(32, readVarintValue(entry)));
      if (type === 'sint32') n = (n >>> 1) ^ -(n & 1);
      return n | 0;
    }
    case 'uint64':
      return readVarintValue(entry);
    case 'int64':
      return BigInt.asIntN(64, readVarintValue(entry));
    case 'sint64': {
      const n = readVarintValue(entry);
      return (n >> 1n) ^ -(n & 1n);
    }
  }
}

function readVarintValue(entry: RawEntry): bigint {
  const v = decodeVarint(rawValue(entry), 0);
  if (!v) throw new WireError('invalid varint value');
  return v.value;
}

/** Parse one packed chunk into elements, preserving their wire order. */
export function decodePacked(type: ScalarType, payload: Uint8Array): (string | number | bigint | boolean)[] {
  const w = scalarWire(type);
  const out: (string | number | bigint | boolean)[] = [];
  let p = 0;
  if (w === WIRE_VARINT) {
    while (p < payload.length) {
      const v = decodeVarint(payload, p);
      if (!v || v.length === 0) throw new WireError('invalid packed varint');
      const sub: RawEntry = {
        field: 0, wireType: WIRE_VARINT, keyStart: 0, keyEnd: 0,
        valStart: p, valEnd: p + v.length, source: payload,
      };
      out.push(decodeScalar(type, sub) as number | bigint | boolean);
      p += v.length;
    }
  } else if (w === WIRE_FIXED64) {
    if (payload.length % 8 !== 0) throw new WireError('packed fixed64 length not a multiple of 8');
    for (; p < payload.length; p += 8) {
      const sub: RawEntry = {
        field: 0, wireType: WIRE_FIXED64, keyStart: 0, keyEnd: 0,
        valStart: p, valEnd: p + 8, source: payload,
      };
      out.push(decodeScalar(type, sub) as number | bigint);
    }
  } else {
    if (payload.length % 4 !== 0) throw new WireError('packed fixed32 length not a multiple of 4');
    for (; p < payload.length; p += 4) {
      const sub: RawEntry = {
        field: 0, wireType: WIRE_FIXED32, keyStart: 0, keyEnd: 0,
        valStart: p, valEnd: p + 4, source: payload,
      };
      out.push(decodeScalar(type, sub) as number);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Scalar value encoding (canonical: minimal varints, little-endian fixed)
// ---------------------------------------------------------------------------

function u32(n: number): number {
  return n >>> 0;
}

export type EncodableScalar = string | number | bigint | boolean | Uint8Array;

export function encodeScalarValue(w: Writer, type: ScalarType, value: EncodableScalar): void {
  switch (type) {
    case 'double': {
      const b = new Uint8Array(8);
      new DataView(b.buffer).setFloat64(0, Number(value), true);
      w.bytes(b);
      return;
    }
    case 'float': {
      const b = new Uint8Array(4);
      new DataView(b.buffer).setFloat32(0, Number(value), true);
      w.bytes(b);
      return;
    }
    case 'fixed32': {
      const b = new Uint8Array(4);
      new DataView(b.buffer).setUint32(0, u32(Number(value)), true);
      w.bytes(b);
      return;
    }
    case 'sfixed32': {
      const b = new Uint8Array(4);
      new DataView(b.buffer).setInt32(0, Number(value) | 0, true);
      w.bytes(b);
      return;
    }
    case 'fixed64': {
      const b = new Uint8Array(8);
      new DataView(b.buffer).setBigUint64(0, BigInt(value as bigint | number), true);
      w.bytes(b);
      return;
    }
    case 'sfixed64': {
      const b = new Uint8Array(8);
      new DataView(b.buffer).setBigInt64(0, BigInt(value as bigint | number), true);
      w.bytes(b);
      return;
    }
    case 'bool':
      w.bytes(encodeVarint(value ? 1n : 0n));
      return;
    case 'string':
      w.bytes(te.encode(String(value)));
      return;
    case 'bytes': {
      const b = value instanceof Uint8Array ? value : Uint8Array.from(value as Iterable<number>);
      w.bytes(b);
      return;
    }
    case 'enum':
    case 'uint32':
      w.bytes(encodeVarint(BigInt(u32(Number(value)))));
      return;
    case 'int32':
      w.bytes(encodeVarint(BigInt(Number(value) | 0)));
      return;
    case 'sint32': {
      const n = Number(value) | 0;
      const zig = ((n << 1) ^ (n >> 31)) >>> 0;
      w.bytes(encodeVarint(BigInt(zig)));
      return;
    }
    case 'uint64':
      w.bytes(encodeVarint(BigInt(value as bigint | number)));
      return;
    case 'int64':
      w.bytes(encodeVarint(BigInt(value as bigint | number)));
      return;
    case 'sint64': {
      const n = BigInt(value as bigint | number);
      w.bytes(encodeVarint((n << 1n) ^ (n >> 63n)));
      return;
    }
  }
}

/** Encode elements without tags (used inside packed length-delimited values). */
export function encodePackedBody(w: Writer, type: ScalarType, values: readonly EncodableScalar[]): void {
  for (const v of values) encodeScalarValue(w, type, v);
}

export { encodeVarint };
