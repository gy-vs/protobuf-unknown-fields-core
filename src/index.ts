export { decodeVarint, encodeVarint } from './varint.js';
export { Writer, concatBytes } from './writer.js';
export {
  WireError,
  scanMessage, rawKey, rawValue, rawRecord,
  WIRE_VARINT, WIRE_FIXED64, WIRE_LENGTH_DELIMITED,
  WIRE_SGROUP, WIRE_EGROUP, WIRE_FIXED32,
  type RawEntry,
} from './wire.js';
export {
  normalizeSchema, scalarWire, isPackable, acceptableWire,
  decodeScalar, decodePacked, encodeScalarValue, encodePackedBody,
  type Schema, type FieldSchema, type ScalarType,
} from './schema.js';
export {
  DynamicMessage,
  type Entry, type UnknownField, type Field, type ScalarValue,
  type SerializeMode,
} from './message.js';
