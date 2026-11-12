import {
  MAX_VARINT_BYTES,
  type DecodeFailure,
  type DecodeResult,
  type Direction,
  type FieldSpec,
  type OpcodeEncoding,
  type OpcodeSpec,
  type ProtocolSchema,
} from "./types.js";

class FrameError extends Error {
  readonly reason: DecodeFailure["reason"];
  readonly offset: number;

  constructor(reason: DecodeFailure["reason"], offset: number, detail: string) {
    super(detail);
    this.reason = reason;
    this.offset = offset;
  }
}

class FrameReader {
  readonly view: DataView;
  readonly bytes: Uint8Array;
  offset = 0;
  maxOffset = 0;

  constructor(bytes: Uint8Array) {
    this.bytes = bytes;
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }

  seek(offset: number): void {
    if (offset < 0 || offset > this.bytes.byteLength) {
      throw new FrameError("out-of-bounds", offset, `seek outside frame (${offset} > ${this.bytes.byteLength})`);
    }
    this.offset = offset;
  }

  private ensure(size: number): number {
    const start = this.offset;
    if (start + size > this.bytes.byteLength) {
      throw new FrameError(
        "truncated",
        start,
        `need ${size} byte(s) at ${start}, frame length ${this.bytes.byteLength}`,
      );
    }
    this.offset += size;
    if (this.offset > this.maxOffset) this.maxOffset = this.offset;
    return start;
  }

  readU8(): number {
    return this.view.getUint8(this.ensure(1));
  }

  readI8(): number {
    return this.view.getInt8(this.ensure(1));
  }

  readU16(le: boolean): number {
    const at = this.ensure(2);
    return le ? this.view.getUint16(at, true) : this.view.getUint16(at, false);
  }

  readI16(le: boolean): number {
    const at = this.ensure(2);
    return le ? this.view.getInt16(at, true) : this.view.getInt16(at, false);
  }

  readU32(le: boolean): number {
    const at = this.ensure(4);
    return le ? this.view.getUint32(at, true) : this.view.getUint32(at, false);
  }

  readI32(le: boolean): number {
    const at = this.ensure(4);
    return le ? this.view.getInt32(at, true) : this.view.getInt32(at, false);
  }

  readF32(le: boolean): number {
    const at = this.ensure(4);
    return le ? this.view.getFloat32(at, true) : this.view.getFloat32(at, false);
  }

  readF64(le: boolean): number {
    const at = this.ensure(8);
    return le ? this.view.getFloat64(at, true) : this.view.getFloat64(at, false);
  }

  readVarint(): number {
    let value = 0;
    let shift = 0;
    for (let i = 0; i < MAX_VARINT_BYTES; i += 1) {
      const byte = this.readU8();
      value += (byte & 0x7f) * 2 ** shift;
      if ((byte & 0x80) === 0) return value;
      shift += 7;
    }
    throw new FrameError("invalid-value", this.offset, `varint longer than ${MAX_VARINT_BYTES} bytes`);
  }

  readString(byteLength: number): string {
    const at = this.ensure(byteLength);
    return new TextDecoder("utf-8", { fatal: false }).decode(this.bytes.subarray(at, at + byteLength));
  }

  readBytes(byteLength: number): Uint8Array {
    const at = this.ensure(byteLength);
    return this.bytes.slice(at, at + byteLength);
  }
}

function readEncoded(reader: FrameReader, type: OpcodeEncoding): number {
  switch (type) {
    case "u8":
      return reader.readU8();
    case "u16le":
      return reader.readU16(true);
    case "u16be":
      return reader.readU16(false);
    case "varint":
      return reader.readVarint();
  }
}

function readNumeric(reader: FrameReader, field: FieldSpec): number {
  switch (field.type) {
    case "u8":
      return reader.readU8();
    case "i8":
      return reader.readI8();
    case "u16le":
      return reader.readU16(true);
    case "u16be":
      return reader.readU16(false);
    case "i16le":
      return reader.readI16(true);
    case "i16be":
      return reader.readI16(false);
    case "u32le":
      return reader.readU32(true);
    case "u32be":
      return reader.readU32(false);
    case "i32le":
      return reader.readI32(true);
    case "i32be":
      return reader.readI32(false);
    case "f32le":
      return reader.readF32(true);
    case "f32be":
      return reader.readF32(false);
    case "f64le":
      return reader.readF64(true);
    case "f64be":
      return reader.readF64(false);
    case "varint":
      return reader.readVarint();
    default:
      throw new FrameError("invalid-schema", reader.offset, `field ${field.name}: not numeric (${field.type})`);
  }
}

function readSingleField(reader: FrameReader, field: FieldSpec): unknown {
  if (field.type === "string") {
    const byteLength =
      field.lengthType !== undefined
        ? readEncoded(reader, field.lengthType)
        : (field.length ?? Number.NaN);
    if (!Number.isInteger(byteLength) || byteLength < 0) {
      throw new FrameError("invalid-schema", reader.offset, `field ${field.name}: string needs length or lengthType`);
    }
    return reader.readString(byteLength);
  }
  if (field.type === "bytes") {
    const byteLength = field.length ?? reader.bytes.byteLength - reader.offset;
    return reader.readBytes(byteLength);
  }
  const raw = readNumeric(reader, field);
  const scale = field.scale ?? 1;
  const bias = field.bias ?? 0;
  return scale === 1 && bias === 0 ? raw : raw * scale + bias;
}

function readField(reader: FrameReader, field: FieldSpec): unknown {
  if (field.offset !== undefined) reader.seek(field.offset);
  if (field.count === undefined) return readSingleField(reader, field);
  if (!Number.isInteger(field.count) || field.count < 0) {
    throw new FrameError("invalid-schema", reader.offset, `field ${field.name}: bad count ${field.count}`);
  }
  const values: unknown[] = [];
  for (let i = 0; i < field.count; i += 1) values.push(readSingleField(reader, field));
  return values;
}

interface OpcodeGroup {
  offset: number;
  type: OpcodeEncoding;
  byValue: Map<number, OpcodeSpec>;
}

/**
 * Schemas are treated as immutable after load; the cache only avoids
 * re-grouping specs on every frame.
 */
const groupCache = new WeakMap<ProtocolSchema, Map<Direction, OpcodeGroup[]>>();

function groupsFor(schema: ProtocolSchema, direction: Direction): OpcodeGroup[] {
  let perDirection = groupCache.get(schema);
  if (perDirection === undefined) {
    perDirection = new Map();
    groupCache.set(schema, perDirection);
  }
  const cached = perDirection.get(direction);
  if (cached !== undefined) return cached;

  const groups = new Map<string, OpcodeGroup>();
  for (const spec of Object.values(schema.opcodes[direction] ?? {})) {
    const key = `${spec.opcode.offset}:${spec.opcode.type}`;
    let group = groups.get(key);
    if (group === undefined) {
      group = { offset: spec.opcode.offset, type: spec.opcode.type, byValue: new Map() };
      groups.set(key, group);
    }
    group.byValue.set(spec.opcode.value, spec);
  }
  const result = [...groups.values()];
  perDirection.set(direction, result);
  return result;
}

function readOpcodeAt(bytes: Uint8Array, offset: number, type: OpcodeEncoding): number | null {
  const reader = new FrameReader(bytes);
  try {
    reader.seek(offset);
    return readEncoded(reader, type);
  } catch {
    return null;
  }
}

export function decodeFrame(
  schema: ProtocolSchema,
  direction: Direction,
  bytes: Uint8Array,
): DecodeResult {
  const sampleHex = hexOf(bytes);
  const groups = groupsFor(schema, direction);

  if (groups.length === 0) {
    const opcode = bytes.byteLength === 0 ? null : (bytes[0] ?? null);
    return {
      ok: false,
      direction,
      reason: "unknown-opcode",
      opcode,
      offset: 0,
      detail: "schema contains no opcodes for this direction",
      sampleHex,
    };
  }

  let spec: OpcodeSpec | null = null;
  let opcode: number | null = null;
  let opcodeOffset = 0;

  for (const group of groups) {
    const value = readOpcodeAt(bytes, group.offset, group.type);
    if (value === null) continue;
    const match = group.byValue.get(value);
    if (match !== undefined) {
      spec = match;
      opcode = value;
      opcodeOffset = group.offset;
      break;
    }
    if (opcode === null) {
      opcode = value;
      opcodeOffset = group.offset;
    }
  }

  if (spec === null) {
    return {
      ok: false,
      direction,
      reason: "unknown-opcode",
      opcode,
      offset: opcodeOffset,
      detail: opcode === null ? "empty or truncated frame" : `opcode 0x${opcode.toString(16)} is not in schema`,
      sampleHex,
    };
  }

  const reader = new FrameReader(bytes);
  try {
    if (spec.lengthPrefix !== undefined) {
      reader.seek(spec.lengthPrefix.offset);
      const prefixStart = reader.offset;
      const declared = readEncoded(reader, spec.lengthPrefix.type);
      const prefixBytes = reader.offset - prefixStart;
      const prefixEnd = spec.lengthPrefix.offset + prefixBytes;
      const declaredTotal = spec.lengthPrefix.includesHeader ? declared : declared + prefixEnd;
      if (declaredTotal !== bytes.byteLength) {
        throw new FrameError(
          "bad-length-prefix",
          spec.lengthPrefix.offset,
          `declared ${declaredTotal} byte(s), frame has ${bytes.byteLength}`,
        );
      }
    }

    reader.seek(0);
    const fields: Record<string, unknown> = {};
    for (const field of spec.fields) {
      fields[field.name] = readField(reader, field);
    }

    return {
      ok: true,
      direction,
      opcode: opcode ?? spec.opcode.value,
      name: spec.name,
      status: spec.status,
      fields,
      consumedBytes: reader.maxOffset,
    };
  } catch (error) {
    if (error instanceof FrameError) {
      return failure(direction, error.reason, opcode, error.offset, error.message, sampleHex);
    }
    return failure(direction, "invalid-value", opcode, reader.offset, messageOf(error), sampleHex);
  }
}

const TEXT_FIELD_TYPES: Record<string, true> = {
  number: true,
  string: true,
  nullable: true,
  boolean: true,
  array: true,
  any: true,
};

const FIELD_TYPES: Record<FieldSpec["type"], true> = {
  u8: true,
  i8: true,
  u16le: true,
  u16be: true,
  i16le: true,
  i16be: true,
  u32le: true,
  u32be: true,
  i32le: true,
  i32be: true,
  f32le: true,
  f32be: true,
  f64le: true,
  f64be: true,
  varint: true,
  string: true,
  bytes: true,
};

/** Structural validation used by tooling before a schema is trusted. */
export function validateSchema(schema: unknown): string[] {
  const problems: string[] = [];
  if (typeof schema !== "object" || schema === null) return ["schema is not an object"];
  const candidate = schema as Partial<ProtocolSchema>;
  if (candidate.game !== "devast.io") problems.push('game must be "devast.io"');
  if (!Number.isInteger(candidate.schemaVersion)) problems.push("schemaVersion must be an integer");
  if (typeof candidate.gameBuild !== "string" || candidate.gameBuild.length === 0) {
    problems.push("gameBuild must be a non-empty string");
  }
  if (candidate.authoritative !== true && candidate.authoritative !== false) {
    problems.push("authoritative must be boolean");
  }
  for (const direction of ["c2s", "s2c"] as const) {
    const group = candidate.opcodes?.[direction];
    if (typeof group !== "object" || group === null) {
      problems.push(`opcodes.${direction} must be an object`);
      continue;
    }
    const seenOpcodes = new Set<string>();
    for (const [key, spec] of Object.entries(group)) {
      if (spec.direction !== direction) problems.push(`${direction}.${key}: direction mismatch`);
      const opcodeKey = `${spec.opcode.offset}:${spec.opcode.type}:${spec.opcode.value}`;
      if (seenOpcodes.has(opcodeKey)) problems.push(`${direction}.${key}: duplicate opcode ${opcodeKey}`);
      seenOpcodes.add(opcodeKey);
      if (!Number.isInteger(spec.opcode.offset) || spec.opcode.offset < 0) {
        problems.push(`${direction}.${key}: bad opcode offset`);
      }
      if (!["u8", "u16le", "u16be", "varint"].includes(spec.opcode.type)) {
        problems.push(`${direction}.${key}: bad opcode type`);
      }
      if (!Number.isInteger(spec.opcode.value) || spec.opcode.value < 0) {
        problems.push(`${direction}.${key}: bad opcode value`);
      }
      if (spec.lengthPrefix !== undefined) {
        if (!["u8", "u16le", "u16be", "varint"].includes(spec.lengthPrefix.type)) {
          problems.push(`${direction}.${key}: bad lengthPrefix type`);
        }
        if (!Number.isInteger(spec.lengthPrefix.offset) || spec.lengthPrefix.offset < 0) {
          problems.push(`${direction}.${key}: bad lengthPrefix offset`);
        }
      }
      if (!Array.isArray(spec.fields)) {
        problems.push(`${direction}.${key}: fields must be an array`);
        continue;
      }
      const names = new Set<string>();
      for (const field of spec.fields) {
        if (names.has(field.name)) problems.push(`${direction}.${key}: duplicate field ${field.name}`);
        names.add(field.name);
        if (!(field.type in FIELD_TYPES)) {
          problems.push(`${direction}.${key}.${field.name}: unknown field type ${field.type}`);
        }
        if (field.offset !== undefined && (!Number.isInteger(field.offset) || field.offset < 0)) {
          problems.push(`${direction}.${key}.${field.name}: bad offset`);
        }
        if (field.count !== undefined && (!Number.isInteger(field.count) || field.count < 0)) {
          problems.push(`${direction}.${key}.${field.name}: bad count`);
        }
        if (field.length !== undefined && (!Number.isInteger(field.length) || field.length < 0)) {
          problems.push(`${direction}.${key}.${field.name}: bad length`);
        }
        if (field.type === "string" && field.length === undefined && field.lengthType === undefined) {
          problems.push(`${direction}.${key}.${field.name}: string without length`);
        }
      }
    }
  }
  for (const direction of ["c2s", "s2c"] as const) {
    const group = candidate.textOpcodes?.[direction];
    if (group === undefined) continue;
    if (typeof group !== "object" || group === null) {
      problems.push(`textOpcodes.${direction} must be an object`);
      continue;
    }
    const seenTextOpcodes = new Set<number>();
    for (const [key, spec] of Object.entries(group)) {
      if (spec.direction !== direction) problems.push(`textOpcodes.${direction}.${key}: direction mismatch`);
      if (!Number.isInteger(spec.opcode) || spec.opcode < 0) {
        problems.push(`textOpcodes.${direction}.${key}: bad opcode`);
      } else if (seenTextOpcodes.has(spec.opcode)) {
        problems.push(`textOpcodes.${direction}.${key}: duplicate opcode ${spec.opcode}`);
      } else {
        seenTextOpcodes.add(spec.opcode);
      }
      if (!Array.isArray(spec.fields)) {
        problems.push(`textOpcodes.${direction}.${key}: fields must be an array`);
        continue;
      }
      const names = new Set<string>();
      for (const field of spec.fields) {
        if (names.has(field.name)) problems.push(`textOpcodes.${direction}.${key}: duplicate field ${field.name}`);
        names.add(field.name);
        if (!Number.isInteger(field.index) || field.index < 0) {
          problems.push(`textOpcodes.${direction}.${key}.${field.name}: bad index`);
        }
        if (!(field.type in TEXT_FIELD_TYPES)) {
          problems.push(`textOpcodes.${direction}.${key}.${field.name}: unknown type ${field.type}`);
        }
      }
    }
  }
  return problems;
}

function failure(
  direction: Direction,
  reason: DecodeFailure["reason"],
  opcode: number | null,
  offset: number,
  detail: string,
  sampleHex: string,
): DecodeFailure {
  return { ok: false, direction, reason, opcode, offset, detail, sampleHex };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function hexOf(bytes: Uint8Array, max = 32): string {
  const end = Math.min(bytes.length, max);
  let out = "";
  for (let i = 0; i < end; i += 1) {
    out += (bytes[i] ?? 0).toString(16).padStart(2, "0");
    if (i !== end - 1) out += " ";
  }
  return bytes.length > max ? `${out} …` : out;
}
