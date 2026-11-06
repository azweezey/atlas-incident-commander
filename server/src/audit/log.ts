import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
export interface AuditEntry {
  seq: number;
  timestamp: string;
  event: string;
  data: unknown;
  prevHash: string;
  hash: string;
}
const digest = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
export class AuditLog {
  /** Called after every append (used for live dashboard updates). */
  onAppend?: (entry: AuditEntry) => void;
  constructor(
    public path = process.env.AUDIT_LOG_PATH ||
      resolve(
        dirname(fileURLToPath(import.meta.url)),
        "../../data/audit.jsonl",
      ),
  ) {}
  entries(): AuditEntry[] {
    if (!existsSync(this.path)) return [];
    const text = readFileSync(this.path, "utf8");
    return text
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  }
  verify() {
    try {
      let prev = "GENESIS";
      const entries = this.entries();
      for (const [i, entry] of entries.entries()) {
        const { hash, ...body } = entry;
        if (
          body.seq !== i + 1 ||
          body.prevHash !== prev ||
          digest(body) !== hash
        )
          return {
            valid: false,
            count: entries.length,
            error: `Broken chain at entry ${i + 1}`,
          };
        prev = hash;
      }
      return { valid: true, count: entries.length, head: prev };
    } catch {
      return { valid: false, count: 0, error: "Malformed JSONL audit log" };
    }
  }
  append(event: string, data: unknown) {
    if (!this.verify().valid)
      throw new Error("Audit integrity failure; execution blocked");
    const entries = this.entries();
    const body = {
      seq: entries.length + 1,
      timestamp: new Date().toISOString(),
      event,
      data: JSON.parse(JSON.stringify(data)),
      prevHash: entries.at(-1)?.hash || "GENESIS",
    };
    const entry = { ...body, hash: digest(body) };
    mkdirSync(dirname(this.path), { recursive: true });
    appendFileSync(this.path, JSON.stringify(entry) + "\n");
    try {
      this.onAppend?.(entry);
    } catch {
      /* listeners must never break the audit write */
    }
    return entry;
  }
}
