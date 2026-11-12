#!/usr/bin/env node
/**
 * Fixture regression check (Architecture v2, ADR-001).
 *
 * Every fixture directory has meta.json:
 *   { name, gameBuild, schema, frames, expected?, strict? }
 * frames.jsonl: one {"dir":"c2s"|"s2c","hex":"...","note?":"..."} per line.
 *
 * --update rewrites expected.json. Use it only after confirming the schema
 * change is intentional; never to make a red parser green.
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { decodeFrame, validateSchema } from "../../dist/protocol/schema.js";
import { decodeTextFrame } from "../../dist/protocol/text-json.js";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../..");
const fixturesDir = join(root, "fixtures");
const args = new Set(process.argv.slice(2));
const update = args.has("--update");
const strict = args.has("--strict");

function fail(message) {
  console.error(`ERROR: ${message}`);
  process.exitCode = 1;
}

function normalize(value) {
  if (value instanceof Uint8Array) return { bytes: Buffer.from(value).toString("hex") };
  if (Array.isArray(value)) return value.map(normalize);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, normalize(child)]));
  }
  return value;
}

function parseHex(hex, label) {
  const compact = hex.replace(/\s+/g, "");
  if (compact.length === 0 || compact.length % 2 !== 0 || /[^0-9a-f]/i.test(compact)) {
    throw new Error(`${label}: invalid hex "${hex}"`);
  }
  return Buffer.from(compact, "hex");
}

const fixtureDirs = existsSync(fixturesDir)
  ? readdirSync(fixturesDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(fixturesDir, entry.name))
      .filter((dir) => existsSync(join(dir, "meta.json")))
  : [];

if (fixtureDirs.length === 0) {
  console.log("No fixtures found. Add fixtures/<name>/meta.json.");
  process.exit(0);
}

let totalFrames = 0;
let totalOk = 0;
let totalUnknown = 0;
let totalFailures = 0;
let totalStrictFailures = 0;

for (const dir of fixtureDirs) {
  const metaPath = join(dir, "meta.json");
  let meta;
  let schema;
  try {
    meta = JSON.parse(readFileSync(metaPath, "utf8"));
    const schemaPath = resolve(dir, meta.schema);
    schema = JSON.parse(readFileSync(schemaPath, "utf8"));
  } catch (error) {
    fail(`${dir}: cannot load meta/schema: ${error.message}`);
    continue;
  }

  const problems = validateSchema(schema);
  if (problems.length > 0) {
    fail(`${meta.name}: invalid schema:\n  - ${problems.join("\n  - ")}`);
    continue;
  }

  if (meta.gameBuild !== undefined && meta.gameBuild !== schema.gameBuild) {
    console.warn(`WARN ${meta.name}: meta.gameBuild=${meta.gameBuild} schema.gameBuild=${schema.gameBuild}`);
  }

  const framesPath = join(dir, meta.frames ?? "frames.jsonl");
  let lines;
  try {
    lines = readFileSync(framesPath, "utf8").split(/\r?\n/);
  } catch (error) {
    fail(`${meta.name}: cannot read frames: ${error.message}`);
    continue;
  }

  const results = [];
  lines.forEach((line, index) => {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith("#")) return;
    const label = `${meta.name}:${framesPath}:${index + 1}`;
    let frame;
    try {
      frame = JSON.parse(trimmed);
    } catch (error) {
      fail(`${label}: invalid JSON: ${error.message}`);
      return;
    }
    if (frame.dir !== "c2s" && frame.dir !== "s2c") {
      fail(`${label}: dir must be c2s or s2c`);
      return;
    }
    if (frame.kind === "text") {
      if (typeof frame.text !== "string") {
        fail(`${label}: text frame needs a string "text" field`);
        return;
      }
      results.push(decodeTextFrame(schema, frame.dir, frame.text));
      return;
    }
    let bytes;
    try {
      bytes = parseHex(String(frame.hex ?? ""), label);
    } catch (error) {
      fail(error.message);
      return;
    }
    results.push(decodeFrame(schema, frame.dir, bytes));
  });

  const okCount = results.filter((result) => result.ok).length;
  const unknownCount = results.filter((result) => !result.ok && result.reason === "unknown-opcode").length;
  const failureCount = results.length - okCount - unknownCount;
  totalFrames += results.length;
  totalOk += okCount;
  totalUnknown += unknownCount;
  totalFailures += failureCount;

  console.log(
    `${meta.name}: ${okCount}/${results.length} decoded, ${unknownCount} unknown opcode(s), ${failureCount} structural failure(s)`,
  );

  const isStrict = strict || meta.strict === true;
  if (isStrict && unknownCount + failureCount > 0) totalStrictFailures += unknownCount + failureCount;

  const expectedPath = meta.expected ? join(dir, meta.expected) : null;
  if (expectedPath !== null) {
    if (update) {
      writeFileSync(expectedPath, `${JSON.stringify(normalize(results), null, 2)}\n`, "utf8");
      console.log(`  updated ${expectedPath}`);
    } else if (existsSync(expectedPath)) {
      const expected = JSON.parse(readFileSync(expectedPath, "utf8"));
      if (!isDeepStrictEqual(normalize(results), expected)) {
        fail(`${meta.name}: decode output differs from ${meta.expected}. Review the diff; use --update only if the schema change is intended.`);
      } else {
        console.log("  snapshot matches");
      }
    } else {
      console.warn(`  no snapshot at ${expectedPath}; run npm run fixtures:update`);
    }
  }
}

console.log(
  `\nTOTAL: ${totalOk}/${totalFrames} decoded, ${totalUnknown} unknown, ${totalFailures} structural failures`,
);

if (totalStrictFailures > 0) {
  console.error(`STRICT: ${totalStrictFailures} frame(s) are not fully decoded.`);
  process.exitCode = 1;
}
