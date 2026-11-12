import assert from "node:assert/strict";
import test from "node:test";
import { decodeFrame, validateSchema } from "../protocol/schema.js";
import type { ProtocolSchema } from "../protocol/types.js";

function makeSchema(): ProtocolSchema {
  return {
    schemaVersion: 1,
    game: "devast.io",
    gameBuild: "test-build",
    capturedAt: "2026-11-11T00:00:00Z",
    authoritative: true,
    framing: { mode: "ws-message" },
    opcodes: {
      c2s: {
        ping: {
          name: "ping",
          direction: "c2s",
          status: "confirmed",
          opcode: { offset: 0, type: "u8", value: 1 },
          fields: [{ name: "seq", offset: 1, type: "u32le" }],
        },
        move: {
          name: "move",
          direction: "c2s",
          status: "confirmed",
          opcode: { offset: 0, type: "u8", value: 2 },
          fields: [
            { name: "x", offset: 1, type: "f32le" },
            { name: "z", offset: 5, type: "f32le" },
          ],
        },
        chat: {
          name: "chat",
          direction: "c2s",
          status: "hypothesis",
          opcode: { offset: 0, type: "u8", value: 3 },
          fields: [{ name: "text", offset: 1, type: "string", lengthType: "u8" }],
        },
        samples: {
          name: "samples",
          direction: "c2s",
          status: "hypothesis",
          opcode: { offset: 0, type: "u8", value: 4 },
          fields: [{ name: "values", offset: 1, type: "u8", count: 3 }],
        },
        scaled: {
          name: "scaled",
          direction: "c2s",
          status: "hypothesis",
          opcode: { offset: 0, type: "u8", value: 5 },
          fields: [{ name: "hp", offset: 1, type: "u8", scale: 0.5, bias: 10 }],
        },
        framed: {
          name: "framed",
          direction: "c2s",
          status: "confirmed",
          opcode: { offset: 0, type: "u8", value: 7 },
          lengthPrefix: { offset: 1, type: "u8", includesHeader: false },
          fields: [{ name: "seq", offset: 2, type: "u32le" }],
        },
        varintOp: {
          name: "varintOp",
          direction: "c2s",
          status: "hypothesis",
          opcode: { offset: 0, type: "u8", value: 8 },
          fields: [{ name: "value", offset: 1, type: "varint" }],
        },
      },
      s2c: {},
    },
    unknownOpcodes: [],
  };
}

function u8(...values: number[]): Uint8Array {
  return Uint8Array.from(values);
}

function moveFrame(x: number, z: number): Uint8Array {
  const bytes = new Uint8Array(9);
  const view = new DataView(bytes.buffer);
  bytes[0] = 2;
  view.setFloat32(1, x, true);
  view.setFloat32(5, z, true);
  return bytes;
}

test("decodes u8 opcode and u32 field", () => {
  const result = decodeFrame(makeSchema(), "c2s", u8(1, 0x78, 0x56, 0x34, 0x12));
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.name, "ping");
  assert.equal(result.fields.seq, 0x12345678);
  assert.equal(result.consumedBytes, 5);
});

test("decodes f32 coordinates", () => {
  const result = decodeFrame(makeSchema(), "c2s", moveFrame(1.5, -2.25));
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.fields.x, 1.5);
  assert.equal(result.fields.z, -2.25);
});

test("decodes length-prefixed utf8 string", () => {
  const result = decodeFrame(makeSchema(), "c2s", u8(3, 5, 0x68, 0x65, 0x6c, 0x6c, 0x6f));
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.fields.text, "hello");
  assert.equal(result.status, "hypothesis");
});

test("decodes count arrays", () => {
  const result = decodeFrame(makeSchema(), "c2s", u8(4, 10, 20, 30));
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(result.fields.values, [10, 20, 30]);
});

test("applies scale and bias", () => {
  const result = decodeFrame(makeSchema(), "c2s", u8(5, 50));
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.fields.hp, 35);
});

test("validates the declared frame length", () => {
  const ok = decodeFrame(makeSchema(), "c2s", u8(7, 4, 0x78, 0x56, 0x34, 0x12));
  assert.equal(ok.ok, true);
  if (ok.ok) assert.equal(ok.fields.seq, 0x12345678);

  const bad = decodeFrame(makeSchema(), "c2s", u8(7, 5, 0x78, 0x56, 0x34, 0x12));
  assert.equal(bad.ok, false);
  if (!bad.ok) assert.equal(bad.reason, "bad-length-prefix");
});

test("decodes LEB128 varint", () => {
  const result = decodeFrame(makeSchema(), "c2s", u8(8, 0xac, 0x02));
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.fields.value, 300);
});

test("unknown opcode is a typed result, not a throw", () => {
  const result = decodeFrame(makeSchema(), "c2s", u8(0xff, 1, 2));
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.reason, "unknown-opcode");
    assert.equal(result.opcode, 0xff);
    assert.equal(result.offset, 0);
  }
});

test("truncated frame reports the byte offset", () => {
  const result = decodeFrame(makeSchema(), "c2s", u8(2, 0x00, 0x00));
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.reason, "truncated");
    assert.ok(result.offset >= 1);
  }
});

test("empty schema reports unknown for every frame", () => {
  const schema = makeSchema();
  schema.opcodes.c2s = {};
  const result = decodeFrame(schema, "c2s", u8(1, 2));
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, "unknown-opcode");
});

test("validateSchema accepts a well-formed schema", () => {
  assert.deepEqual(validateSchema(makeSchema()), []);
});

test("validateSchema reports concrete problems", () => {
  const schema = makeSchema();
  schema.game = "other" as "devast.io";
  schema.opcodes.c2s.ping!.fields.push({ name: "seq", offset: 2, type: "u8" });
  schema.opcodes.c2s.chat!.fields = [{ name: "text", offset: 1, type: "string" }];
  const problems = validateSchema(schema);
  assert.ok(problems.some((p) => p.includes('game must be "devast.io"')));
  assert.ok(problems.some((p) => p.includes("duplicate field seq")));
  assert.ok(problems.some((p) => p.includes("string without length")));
});
