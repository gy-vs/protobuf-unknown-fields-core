import { describe, expect, it } from 'vitest';
import {
  DynamicMessage,
  WireError,
  encodeVarint,
  type FieldSchema,
} from '../src/index.js';

// ---------------------------------------------------------------------------
// Wire builders
// ---------------------------------------------------------------------------

function v(field: number, value: number | bigint, raw?: number[]): Uint8Array {
  const tag = encodeVarint(field << 3);
  const val = raw ? Uint8Array.from(raw) : encodeVarint(value);
  return concat(tag, val);
}
function i32(field: number, value: number): Uint8Array {
  const tag = encodeVarint((field << 3) | 5);
  const b = new Uint8Array(4);
  new DataView(b.buffer).setInt32(0, value, true);
  return concat(tag, b);
}
function i64(field: number, value: bigint): Uint8Array {
  const tag = encodeVarint((field << 3) | 1);
  const b = new Uint8Array(8);
  new DataView(b.buffer).setBigInt64(0, value, true);
  return concat(tag, b);
}
function ld(field: number, payload: Uint8Array): Uint8Array {
  return concat(encodeVarint((field << 3) | 2), encodeVarint(payload.length), payload);
}
function str(field: number, s: string): Uint8Array {
  return ld(field, new TextEncoder().encode(s));
}
function dbl(field: number, value: number): Uint8Array {
  const tag = encodeVarint((field << 3) | 1);
  const b = new Uint8Array(8);
  new DataView(b.buffer).setFloat64(0, value, true);
  return concat(tag, b);
}
function flt(field: number, value: number): Uint8Array {
  const tag = encodeVarint((field << 3) | 5);
  const b = new Uint8Array(4);
  new DataView(b.buffer).setFloat32(0, value, true);
  return concat(tag, b);
}
function sg(field: number, body: Uint8Array): Uint8Array {
  return concat(encodeVarint((field << 3) | 3), body, encodeVarint((field << 3) | 4));
}
function concat(...parts: Uint8Array[]): Uint8Array {
  const n = parts.reduce((a, p) => a + p.length, 0);
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}
function hex(b: Uint8Array): string {
  return [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
}

const personSchema: FieldSchema[] = [
  { number: 1, type: 'string' },
  { number: 2, type: 'int32' },
  { number: 3, type: 'message', schema: [{ number: 1, type: 'string' }] },
  { number: 7, type: 'sint64', repeated: true, packed: true },
  { number: 8, type: 'int32', repeated: true },
  { number: 9, type: 'group', schema: [{ number: 1, type: 'int32' }] },
  { number: 10, type: 'double' },
  { number: 11, type: 'float' },
  { number: 12, type: 'fixed32' },
  { number: 13, type: 'fixed64' },
  { number: 14, type: 'sfixed32' },
  { number: 15, type: 'sfixed64' },
  { number: 16, type: 'bool' },
  { number: 17, type: 'bytes' },
  { number: 18, type: 'uint32' },
  { number: 19, type: 'uint64' },
  { number: 20, type: 'enum' },
  { number: 21, type: 'sint32' },
];

describe('fidelity: unedited messages round-trip byte-for-byte', () => {
  it('every wire type preserves bytes', () => {
    const msg = concat(
      v(1, 0, [0]), // also non-canonical zero
      str(1, 'hi'),
      v(2, 150),
      v(7, 0, [1]),
      i32(12, 0x12345678),
      i64(13, 0x123456789abcdef0n),
      i32(14, -123),
      i64(15, -456n),
      v(16, 1),
      ld(17, Uint8Array.from([1, 2, 3])),
      ld(3, concat(str(1, 'nested'))),
      dbl(10, 3.25),
      flt(11, 1.5),
      sg(9, v(1, 42)),
      v(99, 7), // unknown varint
      i32(100, 1), // unknown fixed32
      i64(101, 9n), // unknown fixed64
      str(102, 'unk'), // unknown length-delimited
      sg(103, v(200, 5)), // unknown group
    );
    const dm = DynamicMessage.decode(msg, personSchema);
    expect(hex(dm.serialize('preserve'))).toBe(hex(msg));
  });

  it('preserves non-canonical (over-long) varints for known scalar', () => {
    // 300 encoded with a trailing zero byte (canonical is ac 02, two bytes).
    const noncanon = concat(
      v(2, 0, [0xac, 0x82, 0x00]),
      v(18, 0, [0xff, 0xff, 0xff, 0xff, 0x0f]),
    );
    const dm = DynamicMessage.decode(noncanon, personSchema);
    expect(dm.get(2)).toBe(300);
    expect(hex(dm.serialize('preserve'))).toBe(hex(noncanon));
  });

  it('preserves packed + unpacked mix shape and order', () => {
    // field 8 repeated int32, not packed by schema: two unpacked then one packed
    const msg = concat(
      v(8, 1),
      v(8, 2),
      ld(8, concat(encodeVarint(3), encodeVarint(4), encodeVarint(5))),
      v(8, 6),
    );
    const dm = DynamicMessage.decode(msg, personSchema);
    expect(dm.getAll(8)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(hex(dm.serialize('preserve'))).toBe(hex(msg));
  });

  it('preserves relative interleaving of known and unknown records', () => {
    const msg = concat(str(1, 'a'), v(500, 1), v(2, 3), v(500, 2), str(1, 'b'));
    const dm = DynamicMessage.decode(msg, personSchema);
    const nums = dm.entries.map((e) => e.field);
    expect(nums).toEqual([1, 500, 2, 500, 1]);
    expect(hex(dm.serialize('preserve'))).toBe(hex(msg));
  });
});

describe('unknown field retention', () => {
  it('stores number, wire type, key/value bytes and order', () => {
    const msg = concat(v(2, 9), v(99, 77), str(1, 'x'));
    const dm = DynamicMessage.decode(msg, personSchema);
    const unk = dm.unknown();
    expect(unk).toHaveLength(1);
    expect(unk[0].number).toBe(99);
    expect(unk[0].wireType).toBe(0);
    expect([...unk[0].key]).toEqual([0x98, 0x06]); // tag (99<<3)
    expect([...unk[0].value]).toEqual([77]);
    expect(unk[0].order).toBe(1);
    expect(hex(unk[0].raw)).toBe('98064d');
  });

  it('unknown records for all wire types', () => {
    const msg = concat(
      v(300, 1),
      i64(301, 1n),
      ld(302, Uint8Array.of(9)),
      sg(303, v(1, 1)),
      i32(304, 1),
    );
    const dm = DynamicMessage.decode(msg, []);
    expect(dm.unknown().map((u) => [u.number, u.wireType])).toEqual([
      [300, 0], [301, 1], [302, 2], [303, 3], [304, 5],
    ]);
    expect(hex(dm.serialize('preserve'))).toBe(hex(msg));
  });

  it('same number but different wire type does not overwrite known value', () => {
    // field 2 known as int32 (wire 0); an unknown same-number fixed64 (wire 1)
    const msg = concat(v(2, 123), i64(2, 9n), v(2, 124));
    const dm = DynamicMessage.decode(msg, personSchema);
    // Known entries: the two wire-0 records; the fixed64 stays unknown.
    expect(dm.getAll ? dm.get(2) : null).toBe(124);
    const unk = dm.unknown();
    expect(unk).toHaveLength(1);
    expect(unk[0].number).toBe(2);
    expect(unk[0].wireType).toBe(1);
    expect(hex(dm.serialize('preserve'))).toBe(hex(msg));
  });

  it('unknown group survives with body and paired tags', () => {
    const body = concat(v(400, 7), sg(401, v(1, 1)));
    const msg = sg(350, body);
    const dm = DynamicMessage.decode(msg, []);
    expect(dm.unknown()).toHaveLength(1);
    expect(hex(dm.serialize('preserve'))).toBe(hex(msg));
  });
});

describe('group pairing validation', () => {
  it('rejects unterminated start group', () => {
    expect(() => DynamicMessage.decode(concat(encodeVarint((9 << 3) | 3), v(1, 1)), personSchema))
      .toThrow(WireError);
  });
  it('rejects end tag with mismatched field number', () => {
    const bad = concat(
      encodeVarint((9 << 3) | 3),
      v(1, 1),
      encodeVarint((10 << 3) | 4),
    );
    expect(() => DynamicMessage.decode(bad, personSchema)).toThrow(/does not match/);
  });
  it('rejects stray end group at top level', () => {
    expect(() => DynamicMessage.decode(encodeVarint((9 << 3) | 4), personSchema))
      .toThrow(/unexpected group end/);
  });
  it('nested groups must pair correctly', () => {
    const good = sg(9, concat(v(1, 1), sg(50, v(1, 2))));
    expect(() => DynamicMessage.decode(good, personSchema)).not.toThrow();
    const bad = sg(9, concat(v(1, 1), encodeVarint((50 << 3) | 3), v(1, 2), encodeVarint((51 << 3) | 4)));
    expect(() => DynamicMessage.decode(bad, personSchema)).toThrow(/does not match/);
  });
});

describe('canonical serialization', () => {
  it('sorts fields by number, stable for repeats', () => {
    const msg = concat(v(8, 3), v(2, 1), v(8, 1), v(8, 2), v(1, 0) && str(1, 'a'));
    const dm = DynamicMessage.decode(msg, personSchema);
    const out = DynamicMessage.decode(dm.serialize('canonical'), personSchema);
    const nums = out.entries.map((e) => e.field);
    expect(nums).toEqual([1, 2, 8, 8, 8]);
    // repeated same-number order preserved
    expect(dm.getAll(8)).toEqual([3, 1, 2]);
  });

  it('canonicalizes unpacked repeated ints according to schema packing', () => {
    const schema: FieldSchema[] = [{ number: 1, type: 'int32', repeated: true, packed: true }];
    const msg = concat(v(1, 300), v(1, 1), ld(1, encodeVarint(2)));
    const dm = DynamicMessage.decode(msg, schema);
    const out = dm.serialize('canonical');
    // Expect a single packed record: tag(0a) len 03 (varint 300=2 bytes, 1=1)
    expect(hex(out)).toBe(hex(ld(1, concat(encodeVarint(300), encodeVarint(1), encodeVarint(2)))));
    expect(DynamicMessage.decode(out, schema).getAll(1)).toEqual([300, 1, 2]);
  });

  it('canonical expands packed when schema says unpacked', () => {
    const schema: FieldSchema[] = [{ number: 1, type: 'int32', repeated: true }];
    const msg = ld(1, concat(encodeVarint(1), encodeVarint(2)));
    const dm = DynamicMessage.decode(msg, schema);
    const out = dm.serialize('canonical');
    expect(hex(out)).toBe(hex(concat(v(1, 1), v(1, 2))));
  });

  it('singular scalar repeated occurrences collapse to last value', () => {
    const msg = concat(v(2, 1), v(2, 2));
    const dm = DynamicMessage.decode(msg, personSchema);
    const out = dm.serialize('canonical');
    expect(hex(out)).toBe(hex(v(2, 2)));
  });

  it('canonical minimizes non-canonical known varints', () => {
    const noncanon = v(2, 0, [0xac, 0x82, 0x00]); // 300 with a trailing zero byte
    const dm = DynamicMessage.decode(noncanon, personSchema);
    expect(hex(dm.serialize('canonical'))).toBe(hex(v(2, 300))); // ac 02
  });

  it('canonical re-emits minimal tags for unknown fields but keeps values', () => {
    // Both unknown; canonical sorts by field number (300 before 301) and keeps
    // the raw value bytes verbatim.
    const msg = concat(i64(301, 1n), v(300, 5));
    const dm = DynamicMessage.decode(msg, []);
    const out = dm.serialize('canonical');
    expect(hex(out)).toBe(hex(concat(v(300, 5), i64(301, 1n))));
    // A second canonical pass is stable.
    expect(hex(DynamicMessage.decode(out, []).serialize('canonical'))).toBe(hex(out));
  });

  it('canonical merges multiple singular message records', () => {
    const schema: FieldSchema[] = [
      { number: 1, type: 'message', schema: [{ number: 1, type: 'string' }, { number: 2, type: 'int32' }] },
    ];
    const msg = concat(ld(1, str(1, 'a')), ld(1, v(2, 7)));
    const dm = DynamicMessage.decode(msg, schema);
    const out = dm.serialize('canonical');
    const parsed = DynamicMessage.decode(out, schema);
    const sub = parsed.get(1) as DynamicMessage;
    expect(sub.get(1)).toBe('a');
    expect(sub.get(2)).toBe(7);
    expect(parsed.getMessages(1)).toHaveLength(1);
  });

  it('canonical is idempotent', () => {
    const msg = concat(v(8, 3), v(2, 1), str(1, 'a'), ld(8, encodeVarint(9)), v(400, 1));
    const dm = DynamicMessage.decode(msg, personSchema);
    const once = dm.serialize('canonical');
    const twice = DynamicMessage.decode(once, personSchema).serialize('canonical');
    expect(hex(once)).toBe(hex(twice));
  });
});

describe('mutation preserves unknowns', () => {
  it('editing a known scalar leaves unknowns intact and keeps positions', () => {
    const msg = concat(str(1, 'a'), v(999, 5), v(2, 1), v(999, 6));
    const dm = DynamicMessage.decode(msg, personSchema);
    dm.set(2, 42);
    const out = dm.serialize('preserve');
    const reparsed = DynamicMessage.decode(out, personSchema);
    expect(reparsed.get(2)).toBe(42);
    expect(reparsed.unknown().map((u) => u.number)).toEqual([999, 999]);
    const nums = reparsed.entries.map((e) => e.field);
    expect(nums).toEqual([1, 999, 2, 999]);
  });

  it('deleting a known field does not remove same-number unknown', () => {
    const msg = concat(v(2, 7), i64(2, 1n)); // known int32 + unknown fixed64 same #
    const dm = DynamicMessage.decode(msg, personSchema);
    expect(dm.delete(2)).toBe(true);
    const out = dm.serialize('preserve');
    const reparsed = DynamicMessage.decode(out, personSchema);
    expect(reparsed.has(2)).toBe(false);
    expect(reparsed.unknown()).toHaveLength(1);
    expect(reparsed.unknown()[0].wireType).toBe(1);
  });

  it('packed field edit round-trips value through preserve and canonical', () => {
    const msg = ld(7, concat(encodeVarint(0), encodeVarint(1))); // sint64 zigzag
    const dm = DynamicMessage.decode(msg, personSchema);
    expect(dm.getAll(7)).toEqual([0n, -1n]);
    dm.setAll(7, [10n, -10n]);
    const out = dm.serialize('canonical');
    expect(DynamicMessage.decode(out, personSchema).getAll(7)).toEqual([10n, -10n]);
  });
});

describe('schema upgrade / re-decode', () => {
  it('previously unknown fields become known with an upgraded schema', () => {
    // Encoded with no schema: both records unknown.
    const wire = concat(v(1, 5), str(2, 'later'));
    let dm = DynamicMessage.decode(wire, []);
    expect(dm.unknown()).toHaveLength(2);

    // Upgrade schema: field 1 is now int32, field 2 string.
    const upgraded: FieldSchema[] = [{ number: 1, type: 'int32' }, { number: 2, type: 'string' }];
    dm = DynamicMessage.decode(dm.serialize('preserve'), upgraded);
    expect(dm.unknown()).toHaveLength(0);
    expect(dm.get(1)).toBe(5);
    expect(dm.get(2)).toBe('later');
  });

  it('schema upgrade preserves remaining unknowns and ordering after canonical', () => {
    const wire = concat(v(1, 5), v(100, 9), str(2, 'x'));
    const upgraded: FieldSchema[] = [{ number: 2, type: 'string' }];
    const dm = DynamicMessage.decode(wire, upgraded);
    const out = dm.serialize('canonical');
    const nums = DynamicMessage.decode(out, upgraded).entries.map((e) => e.field);
    expect(nums).toEqual([1, 2, 100]);
  });
});

describe('repeated scalars across all numeric families', () => {
  const cases: Array<[FieldSchema['type'], (n: number) => Uint8Array, (n: number) => unknown, number]> = [
    ['double', () => {
      const b = new Uint8Array(9);
      const tag = encodeVarint((1 << 3) | 1);
      b.set(tag, 0);
      new DataView(b.buffer, 1).setFloat64(0, 3.5, true);
      return b;
    }, () => 3.5, 9],
    ['float', () => {
      const b = new Uint8Array(5);
      b.set(encodeVarint((1 << 3) | 5), 0);
      new DataView(b.buffer, 1).setFloat32(0, 1.5, true);
      return b;
    }, () => 1.5, 5],
  ];
  for (const [type, build, val, len] of cases) {
    it(`packed/unpacked mix for ${type}`, () => {
      const one = build(0);
      const elems = one.subarray(one.length - (len - 1));
      const schema: FieldSchema[] = [{ number: 1, type, repeated: true }];
      const msg = concat(one, ld(1, concat(elems, elems)));
      const dm = DynamicMessage.decode(msg, schema);
      expect(dm.getAll(1)).toEqual([val(0), val(0), val(0)]);
      expect(hex(dm.serialize('preserve'))).toBe(hex(msg));
      const canon = DynamicMessage.decode(dm.serialize('canonical'), schema);
      expect(canon.getAll(1)).toHaveLength(3);
    });
  }
});

describe('malformed input', () => {
  it('truncated varint tag throws', () => {
    expect(() => DynamicMessage.decode(Uint8Array.of(0x80), [])).toThrow(WireError);
  });
  it('truncated length-delimited value throws', () => {
    expect(() => DynamicMessage.decode(Uint8Array.of(0x0a, 0x05, 1), [])).toThrow(WireError);
  });
  it('truncated fixed64 throws', () => {
    expect(() => DynamicMessage.decode(Uint8Array.of(0x09, 1, 2), [])).toThrow(WireError);
  });
  it('field number 0 throws', () => {
    expect(() => DynamicMessage.decode(Uint8Array.of(0x00), [])).toThrow(/field number 0/);
  });
  it('reserved wire types 6 and 7 throw', () => {
    expect(() => DynamicMessage.decode(Uint8Array.of(0x0e), [])).toThrow(WireError);
    expect(() => DynamicMessage.decode(Uint8Array.of(0x0f), [])).toThrow(WireError);
  });
});

describe('nested messages and groups', () => {
  const sub: FieldSchema[] = [{ number: 1, type: 'int32' }, { number: 2, type: 'int64' }];
  const schema: FieldSchema[] = [
    { number: 1, type: 'message', schema: sub },
    { number: 2, type: 'group', schema: sub },
  ];

  it('nested unknown fields survive both modes', () => {
    const inner = concat(v(1, 5), v(99, 7));
    const gbody = concat(v(1, 6), v(98, 8));
    const msg = concat(ld(1, inner), sg(2, gbody));
    const dm = DynamicMessage.decode(msg, schema);
    expect(hex(dm.serialize('preserve'))).toBe(hex(msg));

    const canon = dm.serialize('canonical');
    const reparsed = DynamicMessage.decode(canon, schema);
    const m = reparsed.get(1) as DynamicMessage;
    expect(m.get(1)).toBe(5);
    expect(m.unknown().map((u) => u.number)).toEqual([99]);
    const g = reparsed.get(2) as DynamicMessage;
    expect(g.get(1)).toBe(6);
    expect(g.unknown().map((u) => u.number)).toEqual([98]);
  });

  it('editing a nested message only rewrites that record in preserve mode', () => {
    const inner = concat(v(2, 100), v(99, 7));
    const msg = concat(str(50, 'x') /* unknown here */, ld(1, inner));
    const dm = DynamicMessage.decode(msg, schema);
    const child = dm.get(1) as DynamicMessage;
    child.set(2, 200n);
    const out = dm.serialize('preserve');
    const reparsed = DynamicMessage.decode(out, schema);
    const m = reparsed.get(1) as DynamicMessage;
    expect(m.get(2)).toBe(200n);
    expect(m.unknown()).toHaveLength(1); // nested unknown kept
    expect(reparsed.unknown().map((u) => u.number)).toEqual([50]); // outer unknown kept
    // outer ordering: unknown 50 before known 1
    expect(reparsed.entries.map((e) => e.field)).toEqual([50, 1]);
  });

  it('known group decodes body values and round-trips', () => {
    const msg = sg(2, concat(v(1, 1), v(2, 2)));
    const dm = DynamicMessage.decode(msg, schema);
    const g = dm.get(2) as DynamicMessage;
    expect(g.get(1)).toBe(1);
    expect(g.get(2)).toBe(2n);
    expect(hex(dm.serialize('preserve'))).toBe(hex(msg));
  });
});

describe('fixed-width and bool packed edge cases', () => {
  it('packed fixed64/fixed32 decode and preserve', () => {
    const schema: FieldSchema[] = [
      { number: 1, type: 'fixed64', repeated: true, packed: true },
      { number: 2, type: 'fixed32', repeated: true, packed: true },
    ];
    const p1 = new Uint8Array(16);
    new DataView(p1.buffer).setBigUint64(0, 1n, true);
    new DataView(p1.buffer, 8).setBigUint64(0, 2n, true);
    const p2 = new Uint8Array(8);
    new DataView(p2.buffer).setUint32(0, 3, true);
    new DataView(p2.buffer, 4).setUint32(0, 4, true);
    const msg = concat(ld(1, p1), ld(2, p2));
    const dm = DynamicMessage.decode(msg, schema);
    expect(dm.getAll(1)).toEqual([1n, 2n]);
    expect(dm.getAll(2)).toEqual([3, 4]);
    expect(hex(dm.serialize('preserve'))).toBe(hex(msg));
  });

  it('non-zero multi-byte bool varint decodes true and preserves bytes', () => {
    const msg = v(16, 0, [0x80, 0x01]); // bool = 128 -> true, non-canonical
    const dm = DynamicMessage.decode(msg, personSchema);
    expect(dm.get(16)).toBe(true);
    expect(hex(dm.serialize('preserve'))).toBe(hex(msg));
    expect(hex(dm.serialize('canonical'))).toBe(hex(v(16, 1)));
  });
});

describe('string and bytes', () => {
  it('string and bytes values round-trip after edit', () => {
    const msg = concat(str(1, 'abc'), ld(17, Uint8Array.of(9, 8, 7)));
    const dm = DynamicMessage.decode(msg, personSchema);
    dm.set(1, 'xyz');
    dm.set(17, Uint8Array.of(1));
    const out = dm.serialize('preserve');
    const reparsed = DynamicMessage.decode(out, personSchema);
    expect(reparsed.get(1)).toBe('xyz');
    expect([...(reparsed.get(17) as Uint8Array)]).toEqual([1]);
  });
});

describe('non-canonical tags and byte-level edits', () => {
  it('preserves non-canonical (over-long) unknown tag bytes in fidelity mode', () => {
    // field 50 wire 0 with an over-long tag; canonical tag is 90 03.
    const tagBytes = Uint8Array.of(0x90, 0x83, 0x00);
    const msg = concat(tagBytes, Uint8Array.of(7));
    const dm = DynamicMessage.decode(msg, personSchema);
    const u = dm.unknown()[0];
    expect(u.number).toBe(50);
    expect([...u.key]).toEqual([0x90, 0x83, 0x00]);
    expect(hex(dm.serialize('preserve'))).toBe(hex(msg));
    // canonical minimizes the tag
    expect(hex(dm.serialize('canonical'))).toBe(hex(v(50, 7)));
  });

  it('deleting a known field removes exactly those bytes in fidelity mode', () => {
    const keep1 = str(1, 'a');
    const dropped = v(2, 5);
    const keep2 = v(99, 1);
    const dm = DynamicMessage.decode(concat(keep1, dropped, keep2), personSchema);
    dm.delete(2);
    expect(hex(dm.serialize('preserve'))).toBe(hex(concat(keep1, keep2)));
  });

  it('re-decoded after schema upgrade, editing the formerly unknown field works', () => {
    const wire = concat(v(1, 5), str(2, 'old'));
    const upgraded: FieldSchema[] = [
      { number: 1, type: 'int32' },
      { number: 2, type: 'string' },
    ];
    const dm = DynamicMessage.decode(wire, upgraded);
    dm.set(1, 6);
    dm.set(2, 'new');
    const out = dm.serialize('canonical');
    const again = DynamicMessage.decode(out, upgraded);
    expect(again.get(1)).toBe(6);
    expect(again.get(2)).toBe('new');
    expect(again.unknown()).toHaveLength(0);
  });

  it('length prefix of an edited known message is rewritten when body grows', () => {
    const schema: FieldSchema[] = [
      { number: 1, type: 'message', schema: [{ number: 1, type: 'string' }] },
    ];
    const dm = DynamicMessage.decode(ld(1, str(1, 'a')), schema);
    (dm.get(1) as DynamicMessage).set(1, 'a much longer string');
    const out = dm.serialize('preserve');
    const reparsed = DynamicMessage.decode(out, schema);
    expect((reparsed.get(1) as DynamicMessage).get(1)).toBe('a much longer string');
  });
});

describe('legacy API compatibility', () => {
  it('decodeVarint still works', async () => {
    const { decodeVarint } = await import('../src/index.js');
    expect(decodeVarint(Uint8Array.from([172, 2]))?.value).toBe(300n);
  });
});
