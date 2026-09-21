/** Protobuf varint helpers. Values are BigInts on the wire. */

export interface VarintResult {
  value: bigint;
  length: number;
}

/**
 * Decode a base-128 varint. Up to 10 bytes are accepted (64-bit payload).
 * Non-minimal (non-canonical) encodings are preserved by callers via raw
 * slices; this reader only rejects truncated or over-long encodings.
 */
export function decodeVarint(
  data: Uint8Array,
  offset = 0,
): VarintResult | null {
  let value = 0n;
  let shift = 0n;
  for (let i = offset; i < data.length && i < offset + 10; i++) {
    const byte = data[i];
    value |= BigInt(byte & 0x7f) << shift;
    if (!(byte & 0x80)) return { value, length: i - offset + 1 };
    shift += 7n;
  }
  return null;
}

/**
 * Encode a 64-bit varint. Negative numbers are treated as unsigned 64-bit
 * (two's complement), matching proto semantics. The output is always minimal
 * (canonical); fidelity for non-minimal source bytes is handled by raw
 * re-emission elsewhere.
 */
export function encodeVarint(value: bigint | number): Uint8Array {
  let v = BigInt(value);
  if (v < 0n) v += 1n << 64n; // unsigned 64-bit two's complement
  const out: number[] = [];
  while (v >= 0x80n) {
    out.push(Number(v & 0x7fn) | 0x80);
    v >>= 7n;
  }
  out.push(Number(v));
  return Uint8Array.from(out);
}
