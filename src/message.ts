import {
  WIRE_EGROUP, WIRE_LENGTH_DELIMITED, WIRE_SGROUP,
  type RawEntry, WireError, rawKey, rawRecord, rawValue, scanMessage,
} from './wire.js';
import { encodeVarint } from './varint.js';
import { Writer, concatBytes } from './writer.js';
import {
  type FieldSchema, type ScalarType, type Schema,
  acceptableWire, decodePacked, decodeScalar, encodePackedBody, encodeScalarValue,
  isPackable, normalizeSchema, scalarWire,
} from './schema.js';

export type ScalarValue = string | number | bigint | boolean | Uint8Array;

/** One retained unknown wire record. */
export interface UnknownField {
  number: number;
  wireType: number;
  /** Original tag bytes. */
  key: Uint8Array;
  /** Original value bytes (payload only; groups: the body between the tags). */
  value: Uint8Array;
  /** The whole original record (for groups: includes both tags). */
  raw: Uint8Array;
  /** Position among all top-level records (0-based, known and unknown mixed). */
  order: number;
}

export type EntryKind = 'scalar' | 'message' | 'group' | 'unknown';

/**
 * A retained occurrence in wire order. Repeated known fields have one entry per
 * original chunk (a packed length-delimited record is one chunk carrying
 * several values); merged message/group fields produce one entry per record.
 */
export interface Entry {
  kind: EntryKind;
  field: number;
  /** Known field schema (absent for unknowns). */
  schema?: FieldSchema;
  /** Order index among all top-level records. */
  order: number;

  // known scalar chunk
  values?: ScalarValue[];
  /** True when this known scalar chunk originated as a packed record. */
  packed?: boolean;

  // known message / group
  message?: DynamicMessage;

  // unknown retention
  unknown?: UnknownField;

  // dirty flag for edited known entries
  dirty?: boolean;
  /** Original wire record for entries produced by decode. */
  raw?: RawEntry;
}

/** Backwards-compatible alias used by the original one-line library. */
export interface Field {
  number: number;
  wireType: number;
  raw: Uint8Array;
}

export type SerializeMode = 'preserve' | 'canonical';

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function tag(field: number, wireType: number): Uint8Array {
  return encodeVarint((field << 3) | wireType);
}

export class DynamicMessage {
  private schema: Map<number, FieldSchema>;
  /** Ordered top-level records (known interleaved with unknown). */
  readonly entries: Entry[] = [];

  constructor(schema?: Schema) {
    this.schema = normalizeSchema(schema);
  }

  // -------------------------------------------------------------------------
  // Decoding
  // -------------------------------------------------------------------------

  static decode(data: Uint8Array, schema?: Schema): DynamicMessage {
    const msg = new DynamicMessage(schema);
    msg.ingest(data);
    return msg;
  }

  private ingest(data: Uint8Array): void {
    const raws = scanMessage(data);
    let index = 0;
    for (const raw of raws) {
      // Only depth-0 records belong to this message. Group body records are
      // reached by decoding the group payload; sub-message payloads are not
      // in this flat list at all (scanned separately on access).
      if (raw.depth !== 0) continue;
      const order = index++;
      const fs = this.schema.get(raw.field);

      if (raw.wireType === WIRE_EGROUP) continue;

      if (!fs || !acceptableWire(fs).includes(raw.wireType)) {
        this.entries.push(this.makeUnknown(raw, order));
        continue;
      }

      this.ingestKnown(fs, raw, order);
    }
  }

  private makeUnknown(raw: RawEntry, order: number): Entry {
    const u: UnknownField = {
      number: raw.field,
      wireType: raw.wireType,
      key: rawKey(raw).slice(),
      value: rawValue(raw).slice(),
      raw: rawRecord(raw).slice(),
      order,
    };
    return { kind: 'unknown', field: raw.field, unknown: u, order };
  }

  private ingestKnown(fs: FieldSchema, raw: RawEntry, order: number): void {
    if (fs.type === 'message') {
      // One entry per record; singular message fields are merged on access
      // (proto semantics) and at canonical serialization time. Keeping the
      // records separate is what lets unedited messages round-trip exactly.
      const child = DynamicMessage.decode(rawValue(raw), fs.schema);
      this.entries.push({
        kind: 'message', field: fs.number, schema: fs, message: child, order, raw,
      });
      return;
    }

    if (fs.type === 'group') {
      const body = this.groupBody(raw);
      const child = DynamicMessage.decode(body, fs.schema);
      this.entries.push({
        kind: 'group', field: fs.number, schema: fs, message: child, order, raw,
      });
      return;
    }

    const st = fs.type as ScalarType;
    // A packed chunk is only legal for a repeated field. A length-delimited
    // record on a singular packable scalar has a mismatched wire type and is
    // retained as unknown instead of being misread as a one-element packed.
    if (fs.repeated && raw.wireType === WIRE_LENGTH_DELIMITED && isPackable(st)) {
      let values: ScalarValue[];
      try {
        values = decodePacked(st, rawValue(raw)) as ScalarValue[];
      } catch {
        // Malformed packed payload: keep the bytes as an unknown record rather
        // than corrupting known state.
        this.entries.push(this.makeUnknown(raw, order));
        return;
      }
      this.entries.push({
        kind: 'scalar', field: fs.number, schema: fs, values, packed: true, order, raw,
      });
      return;
    }

    this.entries.push({
      kind: 'scalar', field: fs.number, schema: fs,
      values: [decodeScalar(st, raw) as ScalarValue], order, raw,
    });
  }

  /** Extract a known group's body bytes, validating end tag pairing. */
  private groupBody(raw: RawEntry): Uint8Array {
    if (raw.wireType !== WIRE_SGROUP
      || raw.endKeyStart === undefined || raw.endKeyEnd === undefined) {
      throw new WireError(`group field ${raw.field} is not a valid group`);
    }
    return raw.source.subarray(raw.valStart, raw.valEnd);
  }

  /**
   * Merge another message's records into this one (proto wire merge). Entries
   * are copied in order; singular scalars are last-wins at read time, singular
   * message fields merge via this same operation.
   */
  mergeFrom(other: DynamicMessage): this {
    for (const e of other.entries) this.entries.push({ ...e });
    return this;
  }

  /**
   * Materialize the proto view of a singular message/group field: recursively
   * merge every record carrying that field number.
   */
  private mergedMessage(field: number): DynamicMessage | undefined {
    const list = this.knownEntries(field);
    if (!list.length) return undefined;
    const first = list[0];
    if (first.kind !== 'message' && first.kind !== 'group') return undefined;
    const out = new DynamicMessage(first.schema?.schema);
    for (const e of list) {
      if (e.kind === 'message' || e.kind === 'group') out.mergeFrom(e.message!);
    }
    return out;
  }

  // -------------------------------------------------------------------------
  // Access / mutation
  // -------------------------------------------------------------------------

  private knownEntries(field: number): Entry[] {
    return this.entries.filter((e) => e.field === field && e.kind !== 'unknown');
  }

  /**
   * Singular field value per proto read semantics: scalars are last-wins,
   * singular message/group fields are returned recursively merged.
   * For repeated fields returns the first element/first record's message.
   */
  get(field: number): ScalarValue | DynamicMessage | undefined {
    const fs = this.schema.get(field);
    const list = this.knownEntries(field);
    if (!list.length) return undefined;
    if (fs && !fs.repeated && (fs.type === 'message' || fs.type === 'group')) {
      // The common case (one record) returns the live, editable entry so
      // mutations through it are reflected when serializing. Multiple records
      // are merged into a fresh view (proto semantics).
      const msgEntries = list.filter(
        (e) => e.kind === 'message' || e.kind === 'group',
      );
      if (msgEntries.length === 1) return msgEntries[0].message!;
      return this.mergedMessage(field);
    }
    const first = list[0];
    if (first.kind === 'message' || first.kind === 'group') return first.message;
    // Scalar: for singular fields the last occurrence wins.
    if (fs && !fs.repeated) {
      for (let i = list.length - 1; i >= 0; i--) {
        if (list[i].kind === 'scalar') return list[i].values![0];
      }
    }
    return first.values?.[0];
  }

  /** All values of a repeated scalar field, across packed/unpacked chunks, in order. */
  getAll(field: number): ScalarValue[] {
    const out: ScalarValue[] = [];
    for (const e of this.knownEntries(field)) {
      if (e.kind === 'scalar' && e.values) out.push(...e.values);
    }
    return out;
  }

  /** All sub-messages/groups of a repeated field, in order. */
  getMessages(field: number): DynamicMessage[] {
    return this.knownEntries(field)
      .filter((e) => e.kind === 'message' || e.kind === 'group')
      .map((e) => e.message!);
  }

  has(field: number): boolean {
    return this.knownEntries(field).length > 0;
  }

  /** Set a singular known field. Scalars replace in place; position is kept. */
  set(field: number, value: ScalarValue): void {
    const fs = this.requireKnown(field);
    if (fs.type === 'message' || fs.type === 'group') {
      throw new WireError(`field ${field} is a ${fs.type}; use setMessage()`);
    }
    if (fs.repeated) {
      throw new WireError(`field ${field} is repeated; use setAll()/add()`);
    }
    const existing = this.knownEntries(field);
    const first = existing[0];
    if (first && first.kind === 'scalar') {
      first.values = [value];
      first.dirty = true;
      // Collapse additional occurrences (singular field had several records).
      for (let i = existing.length - 1; i >= 1; i--) this.removeEntry(existing[i]);
    } else {
      this.appendKnown({
        kind: 'scalar', field, schema: fs, values: [value], dirty: true,
        order: this.nextOrder(),
      });
    }
  }

  setMessage(field: number, value: DynamicMessage): void {
    const fs = this.requireKnown(field);
    if (fs.type !== 'message' && fs.type !== 'group') {
      throw new WireError(`field ${field} is a scalar; use set()`);
    }
    const existing = this.knownEntries(field);
    const first = existing[0];
    if (first) {
      first.message = value;
      first.dirty = true;
      for (let i = existing.length - 1; i >= 1; i--) this.removeEntry(existing[i]);
    } else {
      this.appendKnown({
        kind: fs.type === 'group' ? 'group' : 'message',
        field, schema: fs, message: value, dirty: true, order: this.nextOrder(),
      });
    }
  }

  /** Replace all values of a repeated scalar field. */
  setAll(field: number, values: readonly ScalarValue[]): void {
    const fs = this.requireKnown(field);
    if (!fs.repeated) throw new WireError(`field ${field} is not repeated`);
    if (fs.type === 'message' || fs.type === 'group') {
      throw new WireError(`field ${field} is a repeated ${fs.type}; use setMessages()`);
    }
    for (const e of this.knownEntries(field)) this.removeEntry(e);
    this.appendKnown({
      kind: 'scalar', field, schema: fs, values: values.slice(),
      packed: fs.packed === true, dirty: true, order: this.nextOrder(),
    });
  }

  setMessages(field: number, values: readonly DynamicMessage[]): void {
    const fs = this.requireKnown(field);
    if (!fs.repeated || (fs.type !== 'message' && fs.type !== 'group')) {
      throw new WireError(`field ${field} is not a repeated message/group`);
    }
    for (const e of this.knownEntries(field)) this.removeEntry(e);
    for (const v of values) {
      this.appendKnown({
        kind: fs.type === 'group' ? 'group' : 'message',
        field, schema: fs, message: v, dirty: true, order: this.nextOrder(),
      });
    }
  }

  /** Append one element to a repeated scalar field (never packed). */
  addValue(field: number, value: ScalarValue): void {
    const fs = this.requireKnown(field);
    if (!fs.repeated || fs.type === 'message' || fs.type === 'group') {
      throw new WireError(`field ${field} is not a repeated scalar`);
    }
    this.appendKnown({
      kind: 'scalar', field, schema: fs, values: [value],
      packed: false, dirty: true, order: this.nextOrder(),
    });
  }

  addMessage(field: number, value: DynamicMessage): void {
    const fs = this.requireKnown(field);
    if (!fs.repeated || (fs.type !== 'message' && fs.type !== 'group')) {
      throw new WireError(`field ${field} is not a repeated message/group`);
    }
    this.appendKnown({
      kind: fs.type === 'group' ? 'group' : 'message',
      field, schema: fs, message: value, dirty: true, order: this.nextOrder(),
    });
  }

  /** Delete all known occurrences of a field. Unknown same-number records stay. */
  delete(field: number): boolean {
    const list = this.knownEntries(field);
    for (const e of list) this.removeEntry(e);
    return list.length > 0;
  }

  private removeEntry(target: Entry): void {
    const i = this.entries.indexOf(target);
    if (i >= 0) this.entries.splice(i, 1);
  }

  private appendKnown(e: Entry): void {
    // New known records go after all current records by default.
    this.entries.push(e);
  }

  private nextOrder(): number {
    let max = -1;
    for (const e of this.entries) max = Math.max(max, e.order);
    return max + 1;
  }

  private requireKnown(field: number): FieldSchema {
    const fs = this.schema.get(field);
    if (!fs) throw new WireError(`field ${field} is not declared in schema`);
    return fs;
  }

  /** Retained unknown records in relative order. */
  unknown(): UnknownField[] {
    return this.entries
      .filter((e) => e.kind === 'unknown')
      .map((e) => e.unknown!);
  }

  /**
   * Legacy escape hatch: append a raw record, decoded against the current
   * schema (falling back to unknown retention).
   */
  add(field: { number: number; wireType: number; raw: Uint8Array }): void {
    const data = field.raw;
    const raws = scanMessage(data);
    // Legacy Field described a single record; accept one-record blobs.
    if (raws.length !== 1 || raws[0].field !== field.number || raws[0].wireType !== field.wireType) {
      throw new WireError('add(): raw must be exactly one wire record matching its descriptor');
    }
    const order = this.nextOrder();
    const raw = raws[0];
    const fs = this.schema.get(raw.field);
    if (fs && acceptableWire(fs).includes(raw.wireType) && raw.wireType !== WIRE_EGROUP) {
      this.ingestKnown(fs, raw, order);
    } else {
      this.entries.push(this.makeUnknown(raw, order));
    }
  }

  /** Legacy accessor: every record as number/wireType/raw. */
  get fields(): Field[] {
    return this.entries.map((e) => {
      if (e.kind === 'unknown') {
        return { number: e.field, wireType: e.unknown!.wireType, raw: e.unknown!.raw };
      }
      return { number: e.field, wireType: this.knownWireType(e), raw: this.encodeEntry(e, 'canonical') };
    });
  }

  private knownWireType(e: Entry): number {
    if (e.kind === 'message') return WIRE_LENGTH_DELIMITED;
    if (e.kind === 'group') return WIRE_SGROUP;
    const st = e.schema!.type as ScalarType;
    if (e.packed) return WIRE_LENGTH_DELIMITED;
    return scalarWire(st);
  }

  // -------------------------------------------------------------------------
  // Serialization
  // -------------------------------------------------------------------------

  serialize(mode: SerializeMode = 'preserve'): Uint8Array {
    const w = new Writer();
    if (mode === 'preserve') {
      // Unedited messages round-trip byte-for-byte: every decoded entry knows
      // its original record, unknowns keep raw bytes, ordering untouched.
      for (const e of this.entries) w.bytes(this.encodeEntry(e, mode));
    } else {
      for (const part of this.encodeCanonical()) w.bytes(part);
    }
    return w.finish();
  }

  /**
   * Canonical emission order:
   *  1. stable sort by field number (ties keep encounter order),
   *  2. all chunks of one known scalar field are coalesced (packed/unpacked
   *     mix is normalized per the schema), singular scalars emit last-wins,
   *  3. unknown varints are re-minimized, unknown groups get minimal tags.
   */
  private encodeCanonical(): Uint8Array[] {
    const sorted = this.entries
      .map((e, i) => ({ e, i }))
      .sort((a, b) => (a.e.field - b.e.field) || (a.i - b.i))
      .map((x) => x.e);

    const out: Uint8Array[] = [];
    for (let i = 0; i < sorted.length; i++) {
      const e = sorted[i];
      if (e.kind === 'unknown') {
        out.push(this.encodeUnknown(e, 'canonical'));
        continue;
      }
      if (e.kind === 'message' || e.kind === 'group') {
        if (e.schema?.repeated) {
          out.push(this.encodeEntry(e, 'canonical'));
        } else {
          // Coalesce singular message/group records via proto merge.
          const merged = this.mergedMessage(e.field)!;
          const body = merged.serialize('canonical');
          if (e.kind === 'message') {
            out.push(this.wrapLengthDelimited(e.field, body));
          } else {
            out.push(concatBytes([
              tag(e.field, WIRE_SGROUP), body, tag(e.field, WIRE_EGROUP),
            ]));
          }
          while (i + 1 < sorted.length
            && sorted[i + 1].field === e.field
            && (sorted[i + 1].kind === 'message' || sorted[i + 1].kind === 'group')) {
            i++;
          }
        }
        continue;
      }

      // Coalesce every scalar entry sharing this field number.
      const fs = e.schema!;
      const values: ScalarValue[] = [];
      let j = i;
      while (j < sorted.length
        && sorted[j].field === e.field
        && sorted[j].kind === 'scalar') {
        values.push(...sorted[j].values!);
        j++;
      }
      i = j - 1;

      if (fs.repeated) {
        out.push(this.writeScalarChunks(fs, values, fs.packed === true));
      } else if (values.length > 0) {
        // Singular scalar: proto last-wins semantics.
        out.push(this.writeScalarChunks(fs, [values[values.length - 1]], false));
      }
    }
    return out;
  }

  private encodeEntry(e: Entry, mode: SerializeMode): Uint8Array {
    if (e.kind === 'unknown') return this.encodeUnknown(e, mode);
    if (e.kind === 'message') return this.encodeMessage(e, mode);
    if (e.kind === 'group') return this.encodeGroup(e, mode);
    return this.encodeScalar(e, mode);
  }

  private encodeUnknown(e: Entry, mode: SerializeMode): Uint8Array {
    const u = e.unknown!;
    if (mode === 'preserve') return u.raw.slice();

    // Canonical unknown emission keeps the value verbatim (the wire type
    // determines its shape) but re-emits a minimal tag/length. Non-canonical
    // varint *tags* are thus normalized; non-canonical varint *values* stay
    // byte-exact since their semantic width (e.g. 10-byte max varint) is not
    // inferable without a schema.
    const t = tag(u.number, u.wireType);
    if (u.wireType === WIRE_SGROUP) {
      // Body bytes kept verbatim; both group tags rewritten minimally. Pairing
      // was validated at decode time, so the closing field number matches.
      return concatBytes([t, u.value, tag(u.number, WIRE_EGROUP)]);
    }
    if (u.wireType === WIRE_LENGTH_DELIMITED) {
      return concatBytes([t, encodeVarint(u.value.length), u.value]);
    }
    return concatBytes([t, u.value]);
  }

  private encodeScalar(e: Entry, mode: SerializeMode): Uint8Array {
    const fs = e.schema!;

    if (mode === 'preserve') {
      // Unedited decoded chunks go back out byte-for-byte (non-canonical
      // varints, packed/unpacked shape and order all retained).
      if (!e.dirty && e.raw) return rawRecord(e.raw).slice();
      // Edited scalar: emit in the chunk's original shape when available.
      return this.writeScalarChunks(fs, e.values!, e.packed ?? false);
    }

    // Canonical always re-encodes values (minimal varints, canonical fixed
    // widths); packing is decided by the caller when chunks are coalesced.
    return this.writeScalarChunks(fs, e.values!, e.packed ?? fs.packed === true);
  }

  private writeScalarChunks(
    fs: FieldSchema,
    values: readonly ScalarValue[],
    packed: boolean,
  ): Uint8Array {
    const st = fs.type as ScalarType;
    const w = new Writer();
    if (packed) {
      const body = new Writer();
      encodePackedBody(body, st, values);
      const b = body.finish();
      w.bytes(tag(fs.number, WIRE_LENGTH_DELIMITED));
      w.bytes(encodeVarint(b.length));
      w.bytes(b);
    } else {
      const wt = scalarWire(st);
      for (const v of values) {
        w.bytes(tag(fs.number, wt));
        if (wt === WIRE_LENGTH_DELIMITED) {
          const body = new Writer();
          encodeScalarValue(body, st, v);
          const b = body.finish();
          w.bytes(encodeVarint(b.length));
          w.bytes(b);
        } else {
          encodeScalarValue(w, st, v);
        }
      }
    }
    return w.finish();
  }

  private encodeMessage(e: Entry, mode: SerializeMode): Uint8Array {
    const fs = e.schema!;
    const body = e.message!.serialize(mode);
    if (mode === 'preserve' && !e.dirty && e.raw) {
      // Unedited: reuse original tag+length prefix exactly when the re-serialized
      // nested body is byte-identical (it will be for fully unedited subtrees).
      const originalPayload = rawValue(e.raw);
      if (bytesEqual(body, originalPayload)) return rawRecord(e.raw).slice();
    }
    return this.wrapLengthDelimited(fs.number, body);
  }

  private wrapLengthDelimited(field: number, body: Uint8Array): Uint8Array {
    return concatBytes([tag(field, WIRE_LENGTH_DELIMITED), encodeVarint(body.length), body]);
  }

  private encodeGroup(e: Entry, mode: SerializeMode): Uint8Array {
    const fs = e.schema!;
    const body = e.message!.serialize(mode);
    if (mode === 'preserve' && !e.dirty && e.raw) {
      const originalBody = e.raw.source.subarray(e.raw.valStart, e.raw.valEnd);
      if (bytesEqual(body, originalBody)) return rawRecord(e.raw).slice();
    }
    return concatBytes([tag(fs.number, WIRE_SGROUP), body, tag(fs.number, WIRE_EGROUP)]);
  }
}
