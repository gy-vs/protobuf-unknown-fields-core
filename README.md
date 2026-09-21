# Protocol Buffers core

TypeScript library for wire-format processing with unknown-field preservation.

Decode a message against a known schema, read or modify its known fields, and
serialize it back — fields not in the schema are retained verbatim (field
number, wire type, original key/value bytes, relative order), so nothing is
lost on a round trip.

Run `npm install`, then `npm test` and `npm run build`.

## Modes

- **`preserve`** (default): an unedited message re-serializes byte-for-byte.
  Non-canonical varints, packed/unpacked chunk shapes, and the interleaving of
  known and unknown records are all kept. Only records you actually edit are
  rewritten.
- **`canonical`**: fields are emitted stably sorted by field number, equal
  field numbers keep their relative order, varints/tags/lengths are minimized,
  repeated scalars are packed or unpacked per the schema, singular scalars
  collapse to last-wins, and multiple singular message records merge. Unknown
  values stay byte-exact; only their framing is normalized.

```ts
import { DynamicMessage } from './dist/index.js';

const schema = [
  { number: 1, type: 'string' },
  { number: 2, type: 'int32' },
  { number: 8, type: 'int32', repeated: true }, // unpacked
  { number: 9, type: 'sint64', repeated: true, packed: true },
  { number: 3, type: 'message', schema: [{ number: 1, type: 'string' }] },
];

const msg = DynamicMessage.decode(bytes, schema);

msg.get(1);                 // singular scalar (last-wins)
msg.getAll(8);              // repeated scalar across packed/unpacked chunks
msg.get(3);                 // nested DynamicMessage (live/editable)
msg.unknown();              // [{ number, wireType, key, value, raw, order }]

msg.set(2, 42);
msg.addValue(8, 7);
msg.delete(1);

msg.serialize('preserve');  // byte-identical for everything unedited
msg.serialize('canonical'); // field-number sorted, normalized encoding
```

## Guarantees

- All wire types retained: varint, fixed64, length-delimited, groups
  (start/end pairing and field-number matching validated), fixed32.
- Repeated scalars: packed and unpacked chunks coexist and stay ordered;
  malformed packed payloads fall back to unknown retention.
- A record with a known number but an unexpected wire type is kept as unknown;
  it never overwrites the known value.
- Unknown groups retain their body and both tags; group nesting is validated.
- Non-canonical (over-long) varint values and tags survive `preserve` mode and
  are minimized in `canonical` mode.
- Deleting a known field leaves same-number unknown records untouched.
- Re-decoding serialized bytes with an upgraded schema promotes previously
  unknown fields to known ones.
