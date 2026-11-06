# Demo Video Script: Atlas Incident Commander

Two cuts from one recording session:

| Cut | Hackathon | Length limit | Target | Connector on screen |
| --- | --- | --- | --- | --- |
| **A: full cut** | Airwallex Agentic Banking (Tracks 3 + 2) | under 5:00 | **4:30** | **Airwallex** (sandbox mode badge visible) |
| **B: short cut** | PayPal AI Hackathon (Devpost) | **under 3:00** (judges may stop at 3:00) | **2:45** | **PayPal** (sandbox mode badge visible) |

Rules for both cuts: show the real app running (no slides-only sections), keep the header badges visible (connector, sandbox/mock mode, planner), and make **no claims of revenue, customers, users or traction**. No copyrighted music. Say "sandbox" whenever money moves; never imply real funds.

Setup before recording: `npm run dev`, browser at http://localhost:5173 at 1080p, zoom 110%, `POST /api/reset` so the audit log starts clean, real sandbox keys in `.env`, `ANTHROPIC_API_KEY` set so the planner badge reads Claude. Keep a terminal tab ready for the audit-verify shot.

---

## Cut A: Airwallex (4:30)

| # | Time | Shot (what's on screen) | Voiceover |
| --- | --- | --- | --- |
| 1 | 0:00–0:20 | Title card: "Atlas Incident Commander, a governed AI agent for payment incidents." Then the dashboard, header showing **Airwallex · sandbox · Claude**. | "AI agents are starting to move money. When a payout fails or gets stuck, the dangerous move is the obvious one: try again. That's how businesses pay twice. Atlas Incident Commander is an agent that fixes payment incidents, inside guardrails it can't talk its way around." |
| 2 | 0:20–0:45 | Architecture diagram from the README (mermaid render), cursor tracing the path. | "The agent never touches the Airwallex API directly. Every action it proposes goes through a policy engine: spend limits, a beneficiary allowlist, and duplicate-payment checks. Safe actions run. Risky ones go to a human. Anything that would pay twice is blocked. Every step lands in a hash-chained audit log." |
| 3 | 0:45–1:45 | **Track 3, duplicate payout.** Click "Simulate: duplicate payout". Incident appears. Click "Run agent". Show diagnosis and proposed actions, with the second payout marked **DENY**, reason "duplicate: same beneficiary, amount, reference within 24h". | "Here's a vendor invoice that's been submitted twice by a retry storm. The agent diagnoses it and proposes a fix. Notice the policy decision on the second payout: denied. Same beneficiary, same amount, same invoice reference. The agent can propose it, but the guardrail won't execute it. Only one transfer exists in the Airwallex sandbox." (Optional 3-sec cut to the Airwallex sandbox web app transfer list.) |
| 4 | 1:45–2:25 | **Bad beneficiary.** Simulate "failed payout: bad beneficiary". Run agent. Proposal: hold + request verified details, **ESCALATE** because changing bank details is high risk. | "This payout failed because the beneficiary's account details are invalid. A naive agent would 'fix' the bank details and resend, which is exactly how payment fraud works. Atlas escalates instead: a human has to verify any change to where money goes. I approve it with a note, and my name and note go into the record." (Click Approve in the queue.) |
| 5 | 2:25–3:00 | **Stuck transfer.** Simulate "stuck transfer". Run agent. Show the diagnosis: reconcile status, **no** replacement payout; incident moves to **manual review**. | "This transfer has been pending past its SLA, but nothing says it failed. The agent reconciles status and refuses to send a replacement, because resending a pending payment is a duplicate waiting to happen. It flags it for manual review instead." |
| 6 | 3:00–3:45 | **Track 2, intent-bound purchase.** Simulate "over-limit purchase". Show the stated intent (item, merchant category, budget) next to the agent's request. Policy: **DENY / ESCALATE** with reasons "over budget", "off-intent merchant". Click Deny with a note. | "Track two: a purchasing agent. I told it what to buy and the budget. It came back with something over the limit, from a merchant outside the category I approved. The purchase is bound to my intent, so it can't go through without me, and I deny it." |
| 7 | 3:45–4:15 | **Audit timeline.** Scroll the timeline; click "Verify chain" (or terminal: `curl localhost:4000/api/audit/verify`) showing **valid**. | "Every detection, proposal, policy decision, approval and API call is in an append-only log. Each entry is hashed with the one before it, so any edit after the fact breaks the chain. You can replay exactly why the agent did what it did." |
| 8 | 4:15–4:30 | Dashboard wide shot, repo URL on screen. | "Atlas Incident Commander: agents that fix payment problems without paying twice. Built on the Airwallex sandbox with Claude. Code and setup steps are in the repo. Thanks for watching." |

---

## Cut B: PayPal (2:45)

Switch the header toggle to **PayPal** before recording; badge shows **PayPal · sandbox · Claude**.

| # | Time | Shot | Voiceover |
| --- | --- | --- | --- |
| 1 | 0:00–0:15 | Title card, then dashboard with PayPal badge. | "AI agents are starting to send money. When a payout fails, the obvious fix, trying again, is how you pay twice. Atlas Incident Commander is an AI agent for PayPal payouts that fixes incidents inside guardrails." |
| 2 | 0:15–0:35 | Architecture diagram. | "Claude diagnoses the incident and proposes actions. A policy engine checks every action before it reaches the PayPal Payouts API: spend limits, allowlisted recipients and duplicate checks. Risky actions wait for a human. Everything is logged." |
| 3 | 0:35–1:25 | **Duplicate payout** on PayPal: simulate, run agent, second payout **DENY**. Quick cut to the PayPal sandbox business account showing one payout. | "A contractor payout was submitted twice. The agent proposes resolving it, and the policy engine blocks the second payout before it ever calls PayPal: same recipient, amount and reference, so it's denied. The PayPal sandbox shows exactly one payout." |
| 4 | 1:25–1:55 | **Failed payout** using PayPal's sandbox error test value (e.g. `SENDER_EMAIL_UNCONFIRMED`). Agent diagnoses, proposes a fix, **ESCALATE**; approve in queue. | "This payout failed in PayPal's sandbox. Claude reads the error, explains it in plain English and proposes the fix, but changing anything about a payout needs a human, so it goes to the approval queue. I approve it." |
| 5 | 1:55–2:20 | **Intent-bound purchase** (agentic commerce): over-budget, off-intent request is blocked; deny with a note. | "Same guardrails for agentic commerce: a buying agent that goes over budget or off what I asked for gets stopped." |
| 6 | 2:20–2:40 | Audit timeline + "chain valid". | "Every decision is in a tamper-evident audit log you can replay." |
| 7 | 2:40–2:45 | Repo URL, end card. | "Atlas Incident Commander, built with PayPal and Claude. Setup steps are in the repo." |

## Recording checklist

- [ ] Sandbox keys loaded; header shows **sandbox**, not mock (if you have to record in mock mode, say "mock mode" out loud and don't claim sandbox calls).
- [ ] Reset state between takes (`POST /api/reset`).
- [ ] Cut A ≤ 4:59 (target 4:30). Cut B ≤ 2:59 (target 2:45).
- [ ] PayPal cut uploaded to YouTube as **Public**, link tested while logged out.
- [ ] No revenue, customer or traction claims; no copyrighted music.
- [ ] Captions added (judges often watch muted).
