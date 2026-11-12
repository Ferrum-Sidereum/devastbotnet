import type {
  Direction,
  ProtocolSchema,
  TextDecodeFailure,
  TextDecodeResult,
  TextFieldSpec,
  TextOpcodeSpec,
} from "./types.js";

/**
 * Decoder for WebSocket text frames that carry a JSON array with the opcode at
 * index 0. This is a separate wire format from the binary opcode frames and is
 * intentionally schema-driven: no numeric opcode is hardcoded here.
 */
function fieldMatchesType(value: unknown, type: TextFieldSpec["type"]): boolean {
  switch (type) {
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "string":
      return typeof value === "string";
    case "nullable":
      return value === null || typeof value === "string";
    case "boolean":
      return typeof value === "boolean";
    case "array":
      return Array.isArray(value);
    case "any":
      return true;
  }
}

function failure(
  direction: Direction,
  reason: TextDecodeFailure["reason"],
  opcode: number | null,
  offset: number,
  detail: string,
  sample: string,
): TextDecodeFailure {
  return { ok: false, direction, reason, opcode, offset, detail, sample };
}

function findSpec(
  schema: ProtocolSchema,
  direction: Direction,
  opcode: number,
): TextOpcodeSpec | undefined {
  const group = schema.textOpcodes?.[direction];
  if (group === undefined) return undefined;
  return Object.values(group).find((spec) => spec.opcode === opcode);
}

export function decodeTextFrame(
  schema: ProtocolSchema,
  direction: Direction,
  text: string,
): TextDecodeResult {
  const sample = text.slice(0, 120);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    return failure(
      direction,
      "invalid-json",
      null,
      0,
      error instanceof Error ? error.message : String(error),
      sample,
    );
  }

  if (!Array.isArray(parsed)) {
    return failure(direction, "not-array", null, 0, "top-level JSON is not an array", sample);
  }
  if (parsed.length === 0) {
    return failure(direction, "empty-frame", null, 0, "empty JSON array", sample);
  }

  const opcode = parsed[0];
  if (typeof opcode !== "number" || !Number.isInteger(opcode)) {
    return failure(direction, "unknown-opcode", null, 0, "index 0 is not an integer opcode", sample);
  }

  const spec = findSpec(schema, direction, opcode);
  if (spec === undefined) {
    return failure(
      direction,
      "unknown-opcode",
      opcode,
      0,
      `text opcode ${opcode} is not in schema`,
      sample,
    );
  }

  const fields: Record<string, unknown> = {};
  for (const field of spec.fields) {
    const value = parsed[field.index];
    if (value === undefined) {
      return failure(
        direction,
        "missing-field",
        opcode,
        field.index,
        `field ${field.name}: missing index ${field.index}`,
        sample,
      );
    }
    if (!fieldMatchesType(value, field.type)) {
      return failure(
        direction,
        "bad-field-type",
        opcode,
        field.index,
        `field ${field.name}: expected ${field.type}, got ${Array.isArray(value) ? "array" : value === null ? "null" : typeof value}`,
        sample,
      );
    }
    fields[field.name] = value;
  }
  if (spec.rest === true) {
    fields.rest = parsed.slice(1);
  }

  return {
    ok: true,
    direction,
    opcode,
    name: spec.name,
    status: spec.status,
    fields,
    length: parsed.length,
  };
}
