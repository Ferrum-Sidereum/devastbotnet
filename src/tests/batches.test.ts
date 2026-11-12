import assert from "node:assert/strict";
import test from "node:test";
import { decodeFrame } from "../protocol/schema.js";
import type { ProtocolSchema } from "../protocol/types.js";

function schema(): ProtocolSchema {
  return {
    schemaVersion: 1,
    game: "devast.io",
    gameBuild: "capture-2026-11-11",
    capturedAt: "2026-11-11T00:00:00Z",
    authoritative: false,
    framing: { mode: "ws-message" },
    opcodes: {
      c2s: {
        client_command: {
          name: "client_command",
          direction: "c2s",
          status: "hypothesis",
          opcode: { offset: 0, type: "u8", value: 0x47 },
          fields: [
            { name: "key", offset: 1, type: "u8" },
            { name: "command", offset: 2, type: "u8" },
            { name: "payload", offset: 3, type: "bytes" },
          ],
        },
      },
      s2c: {
        entity_batch: {
          name: "entity_batch",
          direction: "s2c",
          status: "hypothesis",
          opcode: { offset: 0, type: "u8", value: 0x14 },
          fields: [
            { name: "key", offset: 1, type: "u8" },
            { name: "records", offset: 2, type: "bytes" },
          ],
        },
      },
    },
    textOpcodes: { c2s: {}, s2c: {} },
    unknownOpcodes: [],
  };
}

test("0x14 entity batch exposes key and raw records", () => {
  const bytes = Uint8Array.from(
    Buffer.from("14ae8ff87faeafb9aeae46b4838346b48383aeadaeae", "hex"),
  );
  const result = decodeFrame(schema(), "s2c", bytes);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.name, "entity_batch");
  assert.equal(result.fields.key, 0xae);
  const records = result.fields.records;
  assert.ok(records instanceof Uint8Array);
  assert.equal(records.length, 20);
  assert.equal(records[0], 0x8f);
});

test("captured 42-byte entity batch decodes two records", () => {
  const bytes = Uint8Array.from(
    Buffer.from("14aeae7eaea3aeaec1b9aeaeaeaeaeaeaeaeaeaeaeaeaedb4fa3afbb1eab01b8fa826bb8fa82aaaeaeae", "hex"),
  );
  const result = decodeFrame(schema(), "s2c", bytes);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.fields.key, 0xae);
  const records = result.fields.records;
  assert.ok(records instanceof Uint8Array);
  assert.equal(records.length, 40);
  assert.equal(records[0], 0xae);
});

test("captured 0x47 command families expose command byte", () => {
  const frames: Array<[string, number, number]> = [
    ["475bc8b9b24a6a12", 0xc8, 5],
    ["475bccb90a91", 0xcc, 3],
    ["475bce9b", 0xce, 1],
    ["475bcab9aef2c7b1aeeaea45366f8613", 0xca, 13],
  ];
  for (const [hex, command, payloadLength] of frames) {
    const result = decodeFrame(schema(), "c2s", Uint8Array.from(Buffer.from(hex, "hex")));
    assert.equal(result.ok, true, hex);
    if (!result.ok) continue;
    assert.equal(result.fields.key, 0x5b, hex);
    assert.equal(result.fields.command, command, hex);
    const payload = result.fields.payload;
    assert.ok(payload instanceof Uint8Array);
    assert.equal(payload.length, payloadLength, hex);
  }
});

test("0x47 client command exposes key and payload length", () => {
  const bytes = Uint8Array.from(Buffer.from("475bc8b9b24a6a12", "hex"));
  const result = decodeFrame(schema(), "c2s", bytes);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.name, "client_command");
  assert.equal(result.fields.key, 0x5b);
  assert.equal(result.fields.command, 0xc8);
  const payload = result.fields.payload;
  assert.ok(payload instanceof Uint8Array);
  assert.equal(payload.length, 5);
});
