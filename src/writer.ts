/** Growable byte buffer for serialization. */
export class Writer {
  private chunks: Uint8Array[] = [];
  private len = 0;

  bytes(b: Uint8Array): this {
    if (b.length) {
      this.chunks.push(b);
      this.len += b.length;
    }
    return this;
  }

  byte(b: number): this {
    this.chunks.push(Uint8Array.of(b & 0xff));
    this.len++;
    return this;
  }

  get length(): number {
    return this.len;
  }

  finish(): Uint8Array {
    if (this.chunks.length === 1) return this.chunks[0];
    const out = new Uint8Array(this.len);
    let off = 0;
    for (const c of this.chunks) {
      out.set(c, off);
      off += c.length;
    }
    this.chunks = [out];
    return out;
  }
}

export function concatBytes(parts: Uint8Array[]): Uint8Array {
  const w = new Writer();
  for (const p of parts) w.bytes(p);
  return w.finish();
}
