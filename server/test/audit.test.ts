import { it, expect, afterEach } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuditLog } from "../src/audit/log.js";
const dirs: string[] = [];
afterEach(() =>
  dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })),
);
function log() {
  const dir = mkdtempSync(join(tmpdir(), "atlas-audit-"));
  dirs.push(dir);
  return new AuditLog(join(dir, "audit.jsonl"));
}
it("verifies chained events and replay order", () => {
  const a = log();
  expect(a.verify().valid).toBe(true);
  a.append("first", { amount: 100 });
  a.append("second", { amount: 200 });
  expect(a.verify()).toMatchObject({ valid: true, count: 2 });
  expect(a.entries()[1].prevHash).toBe(a.entries()[0].hash);
});
it("detects tampering and fails closed on append", () => {
  const a = log();
  a.append("payment", { amount: 100 });
  writeFileSync(a.path, readFileSync(a.path, "utf8").replace("100", "999"));
  expect(a.verify().valid).toBe(false);
  expect(() => a.append("next", {})).toThrow("integrity");
});
it("detects malformed JSON and removed middle entries", () => {
  const a = log();
  for (let n = 0; n < 3; n++) a.append("event", { n });
  const lines = readFileSync(a.path, "utf8").trim().split("\n");
  writeFileSync(a.path, [lines[0], lines[2]].join("\n") + "\n");
  expect(a.verify().valid).toBe(false);
  writeFileSync(a.path, "not json");
  expect(a.verify().valid).toBe(false);
});
