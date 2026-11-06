import { randomUUID } from "node:crypto";
import type { Action, Intent } from "../policy/engine.js";
export interface Approval {
  id: string;
  incidentId: string;
  connector: string;
  action: Action;
  intent?: Intent;
  status: "pending" | "approved" | "denied";
  createdAt: string;
  approver?: string;
  note?: string;
  outcome?: string;
}
export class ApprovalQueue {
  items: Approval[] = [];
  enqueue(
    incidentId: string,
    connector: string,
    action: Action,
    intent?: Intent,
  ) {
    const existing = this.items.find(
      (a) =>
        a.incidentId === incidentId &&
        a.action.idempotencyKey === action.idempotencyKey &&
        a.action.type === action.type,
    );
    if (existing) return existing;
    const a: Approval = {
      id: randomUUID(),
      incidentId,
      connector,
      action: { ...action },
      intent,
      status: "pending",
      createdAt: new Date().toISOString(),
    };
    this.items.push(a);
    return a;
  }
  async decide(
    id: string,
    approve: boolean,
    approver: string,
    note: string,
    execute: (a: Approval) => Promise<string>,
    record: (a: Approval) => void,
  ) {
    const a = this.items.find((a) => a.id === id);
    if (!a) throw new Error("Approval not found");
    if (a.status !== "pending") throw new Error("Approval already decided");
    a.approver = approver;
    a.note = note;
    if (approve) {
      a.outcome = await execute(a);
      a.status = a.outcome.startsWith("Blocked") ? "denied" : "approved";
    } else {
      a.status = "denied";
      a.outcome = "Denied by operator";
    }
    record(a);
    return a;
  }
}
