/**
 * Protocol-as-data types (Architecture v2, ADR-001).
 *
 * Nothing in this module may contain a concrete game opcode: schemas live in
 * config/protocol-schema.json and are loaded at runtime.
 */

export type Direction = "c2s" | "s2c";

export type FieldType =
  | "u8"
  | "i8"
  | "u16le"
  | "u16be"
  | "i16le"
  | "i16be"
  | "u32le"
  | "u32be"
  | "i32le"
  | "i32be"
  | "f32le"
  | "f32be"
  | "f64le"
  | "f64be"
  | "varint"
  | "string"
  | "bytes";

export type OpcodeEncoding = "u8" | "u16le" | "u16be" | "varint";

export interface FieldSpec {
  name: string;
  /** Absolute byte offset from frame start. Omit for sequential layout. */
  offset?: number;
  type: FieldType;
  /** For `string` when `lengthType` is absent, or for `bytes`. */
  length?: number;
  /** Explicit length prefix placed immediately before the value. */
  lengthType?: "u8" | "u16le" | "u16be" | "varint";
  /** Repeat the field `count` times (array of decoded values). */
  count?: number;
  /** raw * scale + bias, for fixed-point fields. */
  scale?: number;
  bias?: number;
  note?: string;
}

export interface OpcodeLocation {
  offset: number;
  type: OpcodeEncoding;
  /** Numeric opcode value; the schema key is a human-readable name. */
  value: number;
}

export interface LengthPrefixSpec {
  offset: number;
  type: OpcodeEncoding;
  /** True when the prefix itself is included in the declared length. */
  includesHeader: boolean;
}

export type OpcodeStatus = "confirmed" | "hypothesis" | "unknown";

export interface OpcodeSpec {
  name: string;
  direction: Direction;
  status: OpcodeStatus;
  opcode: OpcodeLocation;
  lengthPrefix?: LengthPrefixSpec;
  fields: FieldSpec[];
  notes?: string;
}

export interface UnknownOpcodeRecord {
  direction: Direction;
  opcode: number;
  firstSeenAt: string;
  sampleHex: string;
}

export type TextFieldType = "number" | "string" | "nullable" | "boolean" | "array" | "any";

export interface TextFieldSpec {
  name: string;
  /** Index in the JSON array (0 is the opcode). */
  index: number;
  type: TextFieldType;
  note?: string;
}

export interface TextOpcodeSpec {
  name: string;
  direction: Direction;
  status: OpcodeStatus;
  /** Numeric opcode stored at JSON index 0. */
  opcode: number;
  fields: TextFieldSpec[];
  /** Capture all array elements after index 0 as `rest`. */
  rest?: boolean;
  notes?: string;
}

export interface ProtocolSchema {
  schemaVersion: number;
  game: "devast.io";
  gameBuild: string;
  capturedAt: string;
  authoritative: boolean;
  framing: {
    mode: "ws-message" | "length-prefixed" | "unknown";
    notes?: string;
  };
  opcodes: Record<Direction, Record<string, OpcodeSpec>>;
  /** JSON-array frames (WebSocket text), separate from binary opcodes. */
  textOpcodes?: Partial<Record<Direction, Record<string, TextOpcodeSpec>>>;
  unknownOpcodes: UnknownOpcodeRecord[];
}

export type DecodeFailureReason =
  | "unknown-opcode"
  | "truncated"
  | "out-of-bounds"
  | "bad-length-prefix"
  | "invalid-value"
  | "invalid-schema";

export interface DecodedFrame {
  ok: true;
  direction: Direction;
  opcode: number;
  name: string;
  status: OpcodeStatus;
  fields: Record<string, unknown>;
  consumedBytes: number;
}

export interface DecodeFailure {
  ok: false;
  direction: Direction;
  reason: DecodeFailureReason;
  opcode: number | null;
  offset: number;
  detail: string;
  sampleHex: string;
}

export type DecodeResult = DecodedFrame | DecodeFailure;

export interface TextDecodedFrame {
  ok: true;
  direction: Direction;
  opcode: number;
  name: string;
  status: OpcodeStatus;
  fields: Record<string, unknown>;
  length: number;
}

export interface TextDecodeFailure {
  ok: false;
  direction: Direction;
  reason: "invalid-json" | "not-array" | "empty-frame" | "unknown-opcode" | "missing-field" | "bad-field-type";
  opcode: number | null;
  offset: number;
  detail: string;
  sample: string;
}

export type TextDecodeResult = TextDecodedFrame | TextDecodeFailure;

export interface NetEvent {
  readonly seq: number;
  readonly sessionId: string;
  readonly direction: Direction;
  readonly kind: "binary" | "text";
  /** Agent monotonic clock (performance.now). Never mixed with recvTs. */
  readonly agentTs: number;
  /** Orchestrator clock at ingest; the only clock used by TTL and ticks. */
  readonly recvTs: number;
  readonly socketId: string;
  readonly payload: Uint8Array;
  readonly meta?: Readonly<Record<string, string | number | boolean>>;
}

export const MAX_VARINT_BYTES = 5;

export function hexPreview(bytes: Uint8Array, maxBytes = 64): string {
  const end = Math.min(bytes.length, maxBytes);
  let out = "";
  for (let i = 0; i < end; i += 1) {
    out += (bytes[i] ?? 0).toString(16).padStart(2, "0");
    if (i !== end - 1) out += " ";
  }
  return bytes.length > maxBytes ? `${out} … (${bytes.length} B)` : out;
}
