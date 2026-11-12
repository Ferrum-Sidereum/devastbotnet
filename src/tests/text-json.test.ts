import assert from "node:assert/strict";
import test from "node:test";
import { decodeTextFrame } from "../protocol/text-json.js";
import type { ProtocolSchema } from "../protocol/types.js";

function schema(): ProtocolSchema {
  return {
    schemaVersion: 1,
    game: "devast.io",
    gameBuild: "test",
    capturedAt: "2026-11-11T00:00:00Z",
    authoritative: false,
    framing: { mode: "unknown" },
    opcodes: { c2s: {}, s2c: {} },
    textOpcodes: {
      c2s: {},
      s2c: {
        roster: {
          name: "roster",
          direction: "s2c",
          status: "hypothesis",
          opcode: 2,
          fields: [],
          rest: true,
        },
        pair: {
          name: "pair",
          direction: "s2c",
          status: "hypothesis",
          opcode: 6,
          fields: [
            { name: "first", index: 1, type: "number" },
            { name: "second", index: 2, type: "number" },
          ],
        },
        idNameValue: {
          name: "id_name_value",
          direction: "s2c",
          status: "hypothesis",
          opcode: 8,
          fields: [
            { name: "id", index: 1, type: "number" },
            { name: "name", index: 2, type: "string" },
            { name: "value", index: 3, type: "number" },
          ],
        },
      },
    },
    unknownOpcodes: [],
  };
}

test("decodes a JSON roster into rest", () => {
  const result = decodeTextFrame(schema(), "s2c", JSON.stringify([2, 0, "a", 0, "b"]));
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.opcode, 2);
  assert.equal(result.name, "roster");
  assert.deepEqual(result.fields.rest, [0, "a", 0, "b"]);
  assert.equal(result.length, 5);
});

test("decodes typed fields by index", () => {
  const result = decodeTextFrame(schema(), "s2c", JSON.stringify([8, 42, "player", 7]));
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(result.fields, { id: 42, name: "player", value: 7 });
});

test("unknown text opcode is a typed failure", () => {
  const result = decodeTextFrame(schema(), "s2c", JSON.stringify([99, 1]));
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.reason, "unknown-opcode");
    assert.equal(result.opcode, 99);
  }
});

test("non-JSON, non-array and empty frames are reported", () => {
  for (const [text, reason] of [
    ["not json", "invalid-json"],
    ['{"op":2}', "not-array"],
    ["[]", "empty-frame"],
    ["[", "invalid-json"],
  ] as const) {
    const result = decodeTextFrame(schema(), "s2c", text);
    assert.equal(result.ok, false, text);
    if (!result.ok) assert.equal(result.reason, reason, text);
  }
});

test("missing field and wrong type are reported with the index", () => {
  const missing = decodeTextFrame(schema(), "s2c", JSON.stringify([8, 1, "player"]));
  assert.equal(missing.ok, false);
  if (!missing.ok) {
    assert.equal(missing.reason, "missing-field");
    assert.equal(missing.offset, 3);
  }

  const wrong = decodeTextFrame(schema(), "s2c", JSON.stringify([8, "not-a-number", "player", 7]));
  assert.equal(wrong.ok, false);
  if (!wrong.ok) {
    assert.equal(wrong.reason, "bad-field-type");
    assert.equal(wrong.offset, 1);
  }
});
