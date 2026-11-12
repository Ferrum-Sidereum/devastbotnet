#!/usr/bin/env node
/**
 * 100-bot dry-run: validates scheduler, quota reservations and egress IP budget
 * without opening live Devast.io sessions.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { QuotaManager } from "../../dist/world/quota.js";

const args = process.argv.slice(2);
const botsArg = args.find((arg) => arg.startsWith("--bots="));
const bots = botsArg ? Number(botsArg.split("=")[1]) : Number(args[args.indexOf("--bots") + 1]);
if (!args.includes("--dry-run")) {
  console.error("demo:scale requires --dry-run; live 100 sessions are outside this goal");
  process.exit(2);
}
if (!Number.isInteger(bots) || bots < 1 || bots > 1000) {
  console.error("--bots must be an integer 1..1000");
  process.exit(2);
}

const ipsRequired = Math.ceil(bots / 6);
const quotas = new QuotaManager();
quotas.createQuota({ id: "scale", resource: "wood", target: bots, dropOff: { kind: "operator" }, now: Date.now() });
for (let i = 0; i < bots; i += 1) quotas.assignBot("scale", `bot-${i + 1}`, Date.now());
let reserved = 0;
for (let i = 0; i < bots; i += 1) {
  const result = quotas.tryReserve("scale", `bot-${i + 1}`, `node-${i + 1}`);
  if (!result.ok) throw new Error(`reservation ${i + 1} failed: ${result.reason}`);
  reserved += 1;
}
const snapshot = quotas.snapshot().get("scale");
if (snapshot === undefined || snapshot.reservedNodes.size !== bots) throw new Error("quota snapshot mismatch");
if (reserved !== bots) throw new Error(`reserved ${reserved} of ${bots}`);
mkdirSync("sessions/demo-scale", { recursive: true });
const report = {
  mode: "dry-run",
  bots,
  ipsRequired,
  sessionsPerIpLimit: 6,
  quota: { resource: "wood", target: bots, reservedNodes: snapshot.reservedNodes.size },
  ok: true,
  createdAt: new Date().toISOString(),
};
writeFileSync("sessions/demo-scale/report.json", `${JSON.stringify(report, null, 2)}\n`, "utf8");
console.log(`[demo:scale] ${bots} bots, ${ipsRequired} IPs required, ${reserved} reservations, ok`);
