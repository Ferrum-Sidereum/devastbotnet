#!/usr/bin/env node
/**
 * Session analyzer (Architecture v2, ADR-001).
 *
 * Reads sessions/<dir>/{index.jsonl,frames.bin,actions.jsonl} and writes:
 *   report.md        human-readable candidate table
 *   candidates.json  machine-readable candidate opcodes
 *   report.json      raw aggregates
 *
 * It deliberately does not modify config/protocol-schema.json: a candidate is
 * not a confirmed opcode.
 */
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const sessionsRoot = resolve(here, "../../sessions");

function readJsonl(path) {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line, index) => {
      try {
        return JSON.parse(line);
      } catch (error) {
        throw new Error(`${path}:${index + 1}: ${error.message}`);
      }
    });
}

function bump(map, key) {
  map.set(key, (map.get(key) ?? 0) + 1);
}

function hex(buffer, max = 32) {
  const end = Math.min(buffer.length, max);
  let out = "";
  for (let i = 0; i < end; i += 1) {
    out += buffer[i].toString(16).padStart(2, "0");
    if (i !== end - 1) out += " ";
  }
  return buffer.length > max ? `${out} …` : out;
}

function entropy(buffer) {
  if (buffer.length === 0) return 0;
  const counts = new Uint32Array(256);
  for (const byte of buffer) counts[byte] += 1;
  let result = 0;
  for (const count of counts) {
    if (count === 0) continue;
    const p = count / buffer.length;
    result -= p * Math.log2(p);
  }
  return result;
}

function printableRatio(buffer) {
  if (buffer.length === 0) return 0;
  let printable = 0;
  for (const byte of buffer) {
    if (byte === 9 || byte === 10 || byte === 13 || (byte >= 32 && byte <= 126) || byte >= 0xc0) {
      printable += 1;
    }
  }
  return printable / buffer.length;
}

function median(values) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? Math.round((sorted[mid - 1] + sorted[mid]) / 2) : sorted[mid];
}

function topEntries(map, limit = 5) {
  return [...map.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit);
}

function lowerBound(records, target) {
  let low = 0;
  let high = records.length;
  while (low < high) {
    const mid = (low + high) >> 1;
    if ((records[mid].ts ?? 0) < target) low = mid + 1;
    else high = mid;
  }
  return low;
}

function actionKey(action) {
  if (typeof action.label === "string" && action.label.length > 0) return `mark:${action.label}`;
  const raw = action.action ?? {};
  const parts = [raw.type ?? "action"];
  if (raw.code !== undefined) parts.push(String(raw.code));
  if (raw.button !== undefined) parts.push(`b${raw.button}`);
  if (raw.key !== undefined) parts.push(String(raw.key));
  return parts.join(":");
}

function lastSessionDir(root) {
  if (!existsSync(root)) throw new Error(`sessions directory not found: ${root}`);
  const dirs = readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(join(root, entry.name, "index.jsonl")))
    .map((entry) => join(root, entry.name))
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
  if (dirs.length === 0) throw new Error(`no sessions with index.jsonl under ${root}`);
  return dirs[0];
}

const args = process.argv.slice(2);
const emitSchema = args.includes("--emit-schema");
const sessionArg = args.find((arg) => !arg.startsWith("-"));
const sessionDir = sessionArg ? resolve(sessionArg) : lastSessionDir(sessionsRoot);
const indexPath = join(sessionDir, "index.jsonl");
const framesPath = join(sessionDir, "frames.bin");
const actionsPath = join(sessionDir, "actions.jsonl");

if (!existsSync(indexPath) || !existsSync(framesPath)) {
  throw new Error(`not a session directory (missing index.jsonl/frames.bin): ${sessionDir}`);
}

const index = readJsonl(indexPath);
const framesBlob = readFileSync(framesPath);
const actions = readJsonl(actionsPath);
const correlateWindowMs = 500;

const perDirection = new Map();
for (const record of index) {
  const dir = record.dir === "in" ? "in" : "out";
  let bucket = perDirection.get(dir);
  if (bucket === undefined) {
    bucket = {
      frames: 0,
      bytes: 0,
      lengths: new Map(),
      firstBytes: new Map(),
      u16le: new Map(),
      u16be: new Map(),
      signatures: new Map(),
      textOpcodes: new Map(),
      textLike: 0,
    };
    perDirection.set(dir, bucket);
  }
  const payload = framesBlob.subarray(record.offset, record.offset + record.len);
  bucket.frames += 1;
  bucket.bytes += payload.length;
  bump(bucket.lengths, payload.length);
  if (payload.length > 0) {
    bump(bucket.firstBytes, payload[0]);
    if (payload.length >= 2) {
      bump(bucket.u16le, payload.readUInt16LE(0));
      bump(bucket.u16be, payload.readUInt16BE(0));
    }
    if (printableRatio(payload) > 0.9) bucket.textLike += 1;
  }
  if (record.kind === "text") {
    const text = payload.toString("utf8");
    if (text.startsWith("[")) {
      try {
        const array = JSON.parse(text);
        if (Array.isArray(array) && typeof array[0] === "number") {
          const opcode = array[0];
          let entry = bucket.textOpcodes.get(opcode);
          if (entry === undefined) {
            entry = { count: 0, lengths: new Map(), shapes: new Map(), example: text.slice(0, 240) };
            bucket.textOpcodes.set(opcode, entry);
          }
          entry.count += 1;
          bump(entry.lengths, payload.length);
          const shape = array
            .slice(1, 8)
            .map((value) => (value === null ? "null" : Array.isArray(value) ? "array" : typeof value))
            .join(",");
          bump(entry.shapes, array.length > 8 ? `${shape},…` : shape);
        }
      } catch {
        // Not valid JSON; leave it for the binary/unknown tables.
      }
    }
  }

  const signature = `${payload.length}:${payload.length > 0 ? payload[0] : "empty"}`;
  const entry = bucket.signatures.get(signature) ?? {
    count: 0,
    examples: [],
    entropy: 0,
    textLike: false,
  };
  entry.count += 1;
  entry.entropy = Math.max(entry.entropy, entropy(payload));
  entry.textLike = entry.textLike || printableRatio(payload) > 0.9;
  if (entry.examples.length < 3) entry.examples.push(hex(payload));
  bucket.signatures.set(signature, entry);
}

const primed = [...index]
  .map((record) => ({
    ...record,
    buffer: framesBlob.subarray(record.offset, record.offset + record.len),
  }))
  .sort((a, b) => a.ts - b.ts);

const outPrimed = primed.filter((record) => record.dir === "out");
const inPrimed = primed.filter((record) => record.dir === "in");

const actionStats = new Map();
for (const action of actions) {
  const key = actionKey(action);
  let entry = actionStats.get(key);
  if (entry === undefined) {
    entry = { count: 0, outSignatures: new Map(), inSignatures: new Map(), delays: [], inDelays: [] };
    actionStats.set(key, entry);
  }
  entry.count += 1;

  const outIndex = lowerBound(outPrimed, action.ts);
  const outFrame = outPrimed[outIndex];
  if (outFrame !== undefined && outFrame.ts - action.ts <= correlateWindowMs) {
    const signature = `${outFrame.len}:${outFrame.len > 0 ? outFrame.buffer[0] : "empty"}`;
    bump(entry.outSignatures, signature);
    entry.delays.push(outFrame.ts - action.ts);
  }

  const inIndex = lowerBound(inPrimed, action.ts);
  const inFrame = inPrimed[inIndex];
  if (inFrame !== undefined && inFrame.ts - action.ts <= correlateWindowMs) {
    const signature = `${inFrame.len}:${inFrame.len > 0 ? inFrame.buffer[0] : "empty"}`;
    bump(entry.inSignatures, signature);
    entry.inDelays.push(inFrame.ts - action.ts);
  }
}

let minTs = Number.POSITIVE_INFINITY;
let maxTs = Number.NEGATIVE_INFINITY;
for (const record of primed) {
  if (!Number.isFinite(record.ts)) continue;
  if (record.ts < minTs) minTs = record.ts;
  if (record.ts > maxTs) maxTs = record.ts;
}
const durationMs = Number.isFinite(minTs) && Number.isFinite(maxTs) ? maxTs - minTs : 0;

const candidates = {
  session: sessionDir,
  generatedAt: new Date().toISOString(),
  durationMs,
  directions: {},
  actions: [...actionStats.entries()].map(([key, entry]) => ({
    action: key,
    count: entry.count,
    topOutSignatures: topEntries(entry.outSignatures, 5).map(([signature, count]) => ({ signature, count })),
    medianOutDelayMs: median(entry.delays),
    topInSignatures: topEntries(entry.inSignatures, 5).map(([signature, count]) => ({ signature, count })),
    medianInDelayMs: median(entry.inDelays),
  })),
};

for (const [dir, bucket] of perDirection) {
  candidates.directions[dir] = {
    frames: bucket.frames,
    bytes: bucket.bytes,
    textLike: bucket.textLike,
    topLengths: topEntries(bucket.lengths, 20).map(([len, count]) => ({ len, count })),
    firstByteCandidates: topEntries(bucket.firstBytes, 24).map(([firstByte, count]) => ({
      firstByte,
      hex: `0x${firstByte.toString(16).padStart(2, "0")}`,
      count,
      topU16le: topEntries(bucket.u16le, 3).map(([value, n]) => ({ value, count: n })),
      topU16be: topEntries(bucket.u16be, 3).map(([value, n]) => ({ value, count: n })),
    })),
    textOpcodes: [...bucket.textOpcodes.entries()]
      .map(([opcode, entry]) => ({
        opcode,
        count: entry.count,
        lengths: topEntries(entry.lengths, 8).map(([len, count]) => ({ len, count })),
        shapes: topEntries(entry.shapes, 8).map(([shape, count]) => ({ shape, count })),
        example: entry.example,
      }))
      .sort((a, b) => a.opcode - b.opcode),
    signatures: [...bucket.signatures.entries()]
      .map(([signature, entry]) => ({
        signature,
        count: entry.count,
        entropy: Number(entry.entropy.toFixed(2)),
        textLike: entry.textLike,
        examples: entry.examples,
      }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 80),
  };
}

const lines = [];
lines.push(`# Protocol capture report`);
lines.push("");
lines.push(`- Session: \`${sessionDir}\``);
lines.push(`- Generated: ${candidates.generatedAt}`);
lines.push(`- Duration: ${(durationMs / 1000).toFixed(1)} s`);
lines.push(`- Frames: ${index.length}, actions: ${actions.length}`);
lines.push("");
lines.push(`## Directions`);
lines.push("");
lines.push("| dir | frames | bytes | text-like | top lengths |");
lines.push("| --- | ---: | ---: | ---: | --- |");
for (const dir of ["in", "out"]) {
  const bucket = perDirection.get(dir);
  if (bucket === undefined) continue;
  const topLengths = topEntries(bucket.lengths, 6)
    .map(([len, count]) => `${len}×${count}`)
    .join(", ");
  lines.push(`| ${dir} | ${bucket.frames} | ${bucket.bytes} | ${bucket.textLike} | ${topLengths} |`);
}
lines.push("");

for (const dir of ["out", "in"]) {
  const bucket = perDirection.get(dir);
  if (bucket === undefined) continue;
  if (bucket.textOpcodes.size > 0) {
    lines.push(`## ${dir === "out" ? "Client → server" : "Server → client"} text JSON opcodes`);
    lines.push("");
    lines.push("| opcode | count | lengths | shape | example |");
    lines.push("| ---: | ---: | --- | --- | --- |");
    for (const [opcode, entry] of [...bucket.textOpcodes.entries()].sort((a, b) => a[0] - b[0])) {
      const lengths = topEntries(entry.lengths, 4).map(([len, count]) => `${len}×${count}`).join(", ");
      const shape = topEntries(entry.shapes, 3).map(([value, count]) => `${value}×${count}`).join("; ");
      const example = entry.example.replace(/\|/g, "\\|");
      lines.push(`| ${opcode} | ${entry.count} | ${lengths} | ${shape} | \`${example}\` |`);
    }
    lines.push("");
  }
  lines.push(`## ${dir === "out" ? "Client → server" : "Server → client"} signatures`);
  lines.push("");
  lines.push("| len | first byte | count | entropy | text-like | example |");
  lines.push("| ---: | --- | ---: | ---: | --- | --- |");
  const rows = [...bucket.signatures.entries()]
    .map(([signature, entry]) => {
      const [lenText, first] = signature.split(":");
      return { len: Number(lenText), first, ...entry };
    })
    .sort((a, b) => b.count - a.count)
    .slice(0, 40);
  for (const row of rows) {
    const firstHex = row.first === "empty" ? "—" : `0x${Number(row.first).toString(16).padStart(2, "0")}`;
    lines.push(
      `| ${row.len} | ${firstHex} | ${row.count} | ${row.entropy.toFixed(2)} | ${row.textLike ? "yes" : ""} | \`${row.examples[0] ?? ""}\` |`,
    );
  }
  lines.push("");
}

lines.push("## Action correlation");
lines.push("");
lines.push("Nearest outbound and inbound frame within 500 ms after each action. Empty cells mean no candidate.");
lines.push("");
lines.push("| action | count | top out (len:opcode) | median out delay | top in (len:opcode) | median in delay |");
lines.push("| --- | ---: | --- | ---: | --- | ---: |");
for (const entry of candidates.actions.sort((a, b) => b.count - a.count).slice(0, 40)) {
  const topOut = entry.topOutSignatures.map((item) => `${item.signature}×${item.count}`).join(", ");
  const topIn = entry.topInSignatures.map((item) => `${item.signature}×${item.count}`).join(", ");
  lines.push(
    `| \`${entry.action}\` | ${entry.count} | ${topOut} | ${entry.medianOutDelayMs ?? "—"} | ${topIn} | ${entry.medianInDelayMs ?? "—"} |`,
  );
}
lines.push("");
lines.push("## How to read this");
lines.push("");
lines.push("1. `len:firstByte` is a *candidate* signature, not a confirmed opcode.");
lines.push("2. A signature repeated across sessions with a stable action correlation is a hypothesis worth testing.");
lines.push("3. Confirm fields on 3+ independent sessions before editing `config/protocol-schema.json` with `status: \"confirmed\"`.");
lines.push("4. High entropy + variable length usually means compressed or encrypted payload; do not guess fields.");
lines.push("");

if (emitSchema) {
  const draft = {
    schemaVersion: 1,
    game: "devast.io",
    gameBuild: "unverified",
    capturedAt: new Date().toISOString(),
    authoritative: false,
    framing: {
      mode: "unknown",
      notes: `Draft generated from ${sessionDir}. Opcode offset/type are guesses; fields are empty until confirmed.`,
    },
    opcodes: { c2s: {}, s2c: {} },
    unknownOpcodes: [],
  };
  for (const direction of ["c2s", "s2c"]) {
    const key = direction === "c2s" ? "out" : "in";
    const bucket = perDirection.get(key);
    if (bucket === undefined) continue;
    for (const [firstByte, count] of topEntries(bucket.firstBytes, 24)) {
      if (count < 2) continue;
      const variants = [...bucket.signatures.entries()]
        .filter(([signature]) => signature.endsWith(`:${firstByte}`))
        .sort((a, b) => b[1].count - a[1].count)
        .slice(0, 3)
        .map(([signature, entry]) => `${signature}×${entry.count}`);
      const name = `unknown_0x${firstByte.toString(16).padStart(2, "0")}`;
      draft.opcodes[direction][name] = {
        name,
        direction,
        status: "hypothesis",
        opcode: { offset: 0, type: "u8", value: firstByte },
        fields: [],
        notes: `${count} frame(s); candidate signatures ${variants.join(", ")}. Fields not decoded.`,
      };
    }
  }
  writeFileSync(join(sessionDir, "protocol-schema.draft.json"), `${JSON.stringify(draft, null, 2)}\n`, "utf8");
  console.log("  wrote protocol-schema.draft.json (hypotheses only)");
}

writeFileSync(join(sessionDir, "candidates.json"), `${JSON.stringify(candidates, null, 2)}\n`, "utf8");
writeFileSync(join(sessionDir, "report.md"), lines.join("\n"), "utf8");

console.log(`[analyze] ${sessionDir}`);
for (const [dir, bucket] of perDirection) {
  console.log(`  ${dir}: ${bucket.frames} frame(s), ${bucket.lengths.size} distinct length(s)`);
}
console.log(`  actions: ${actions.length}`);
console.log(`  wrote report.md, candidates.json${emitSchema ? ", protocol-schema.draft.json" : ""}`);
