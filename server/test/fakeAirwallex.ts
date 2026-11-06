// Stateful fake of the Airwallex sandbox, built from responses recorded on 2026-10-27
// (see docs/SANDBOX_RUN_LOG.md). No network, no credentials.
export class FakeAirwallex {
  logins = 0;
  creates = 0;
  calls: string[] = [];
  transfers = new Map<string, any>();
  beneficiaries = new Map<string, any>();
  failCreateWith?: "timeout";
  expiredOnce = false;
  /** USD available balance; debited when a transfer is created (like the sandbox). */
  balance = 10000000;
  private n = 0;
  private nextId() {
    return `00000000-0000-4000-8000-${String(++this.n).padStart(12, "0")}`;
  }
  fetch = async (url: string | URL, init: any = {}): Promise<Response> => {
    const u = new URL(String(url));
    const method = init.method || "GET";
    const body = init.body ? JSON.parse(init.body) : undefined;
    const path = u.pathname;
    this.calls.push(`${method} ${path}${u.search}`);
    const json = (status: number, d: unknown) => Response.json(d, { status });
    if (path === "/api/v1/authentication/login") {
      this.logins++;
      return json(201, {
        token: "fake-token-" + this.logins,
        expires_at: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
      });
    }
    if (this.expiredOnce) {
      this.expiredOnce = false;
      return json(401, { code: "credentials_expired", message: "expired" });
    }
    if (path === "/api/v1/beneficiaries/validate") {
      const r = body?.beneficiary?.bank_details?.account_routing_value1;
      return r && r.length === 9
        ? new Response('"OK"', { status: 200 })
        : json(400, {
            code: "validation_failed",
            details: {
              errors: [
                { code: "019", params: { length: 9 }, source: "beneficiary.bank_details.account_routing_value1" },
              ],
            },
            message: "The request failed our schema validation.",
          });
    }
    if (path === "/api/v1/beneficiaries/create") {
      const id = this.nextId();
      const b = { id, ...body, updated_at: "2026-10-27T00:00:00+0000" };
      this.beneficiaries.set(id, b);
      return json(201, b);
    }
    if (path === "/api/v1/beneficiaries" && method === "GET") {
      const nick = u.searchParams.get("nick_name");
      return json(200, {
        has_more: false,
        items: [...this.beneficiaries.values()].filter((b) => !nick || b.nickname === nick),
      });
    }
    const bene = path.match(/^\/api\/v1\/beneficiaries\/([^/]+)$/);
    if (bene) {
      const b = this.beneficiaries.get(bene[1]);
      return b ? json(200, b) : json(404, { code: "not_found", message: "not found" });
    }
    if (path === "/api/v1/transfers/create") {
      if (this.failCreateWith === "timeout") {
        this.failCreateWith = undefined;
        this.store(body);
        throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
      }
      const dup = [...this.transfers.values()].find((t) => t.request_id === body.request_id);
      if (dup)
        return json(400, {
          code: "duplicate_request_id",
          details: { id: dup.id, request_id: body.request_id },
          message: `The request ID ${body.request_id} has been used for a transfer with the transfer ID ${dup.id} before.`,
          source: "request_id",
        });
      this.creates++;
      this.balance -= Number(body.transfer_amount) || 0;
      return json(201, this.store(body));
    }
    if (path === "/api/v1/transfers" && method === "GET") {
      const rid = u.searchParams.get("request_id");
      const bid = u.searchParams.get("beneficiary_id");
      return json(200, {
        items: [...this.transfers.values()].filter(
          (t) => (!rid || t.request_id === rid) && (!bid || t.beneficiary_id === bid),
        ),
      });
    }
    const sim = path.match(/^\/api\/v1\/simulation\/transfers\/([^/]+)\/transition$/);
    if (sim) {
      const t = this.transfers.get(sim[1]);
      const next = body.next_status;
      const allowed: Record<string, string[]> = {
        PROCESSING: ["SENT"],
        SENT: ["PAID", "FAILED"],
        PAID: ["FAILED"],
      };
      if (!t || !(allowed[t.status] || []).includes(next))
        return json(500, { code: "operation_failed", message: "Request could not be processed" });
      if (next === "FAILED") {
        // Recorded behaviour: FAILED immediately settles to CANCELLED with a failure object.
        t.status = "CANCELLED";
        t.failure = { code: "90101", details: { type: "INCORRECT_ROUTING" }, message: "Invalid account name/number" };
      } else t.status = next;
      t.updated_at = new Date().toISOString();
      return json(200, t);
    }
    const cancel = path.match(/^\/api\/v1\/transfers\/([^/]+)\/cancel$/);
    if (cancel)
      return json(400, { code: "update_unsupported", details: {}, message: "The transfer in the current status cannot be updated.", source: "transfer" });
    const tr = path.match(/^\/api\/v1\/transfers\/([^/]+)$/);
    if (tr) {
      const t = this.transfers.get(tr[1]);
      if (t && t.status === "SCHEDULED") t.status = "PROCESSING"; // sandbox auto-advances
      return t ? json(200, t) : json(404, { code: "not_found", message: "not found" });
    }
    if (path === "/api/v1/balances/current")
      return json(200, [{ currency: "USD", available_amount: this.balance, total_amount: this.balance, account_type: "cash" }]);
    return json(404, { code: "not_found", message: "unhandled " + path });
  };
  private store(body: any) {
    const t = {
      id: this.nextId(),
      request_id: body.request_id,
      beneficiary_id: body.beneficiary_id,
      transfer_amount: Number(body.transfer_amount),
      transfer_currency: body.transfer_currency,
      source_currency: body.source_currency,
      reference: body.reference,
      reason: body.reason,
      status: "SCHEDULED",
      funding: { status: "FUNDED" },
      // Shape recorded 2026-10-28T00:52:12+0000; stamped "now" so the 24h duplicate window tests do not expire with the calendar.
      created_at: new Date().toISOString().replace(/\.\d{3}Z$/, "+0000"),
      updated_at: new Date().toISOString(),
    };
    this.transfers.set(t.id, t);
    return t;
  }
}
