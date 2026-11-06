# Build Plan: Atlas Incident Commander (Oct 26 to Nov 12, 2026)

All times are Arizona time (MST, UTC-7).

## Deadlines that drive this plan

| Event | Deadline (AZ) | Notes |
| --- | --- | --- |
| PayPal AI Hackathon (Devpost) | **Thu Nov 12, 1:00 PM** | Nov 12 is a Thursday, so **we submit on Wed Nov 11**. Video must be **under 3 minutes**, on YouTube, public. Repo must be public on GitHub/GitLab/Bitbucket with a visible license. |
| Airwallex Agentic Banking Hackathon (HackerEarth) | **Fri Nov 13, 11:29 AM** | Video under 5 minutes, working demo, repo with setup steps. **We submit on Wed Nov 11 too**, and Fri morning is only an emergency fallback. |
| Airwallex build phase opens | Mon Oct 26, 9:30 PM | Accepted teams are notified around Oct 27 (per airwallex.hackerearth.com). |
| Airwallex finalists / Demo Day | Nov 15 / Nov 19 | Remote participation optional. |

## Ground rules

- **Thursdays are completely off**: Oct 29, Nov 5 and Nov 12. No coding, no submitting, no checking dashboards.
- Weeknights assume about **1.5 to 2 hours** after a Subway shift; weekend blocks assume **3 to 4 hours**. If a shift runs long, drop the "stretch" item for that day, never the Thursday.
- The project already runs end-to-end in **mock mode** with no keys. Every day should end with `npm test` passing and the mock demo still working, so there is always something submittable.
- The repo is a local git repo on the build box. Pushing to a public GitHub repo is a step Josh takes (or approves) himself.
- Docs and video must make **no claims of revenue, customers, users or traction**.

## Day by day

| Date | Time budget | Focus | Done when |
| --- | --- | --- | --- |
| **Mon Oct 26** | 1.5 h | Get credentials. Create the Airwallex sandbox account and API key; log in to PayPal Developer and create a Sandbox app (see `SANDBOX_SETUP.md`). Put keys in `.env` (never commit it). | Both `curl` token checks in `SANDBOX_SETUP.md` return a token. |
| **Tue Oct 27** | 1.5 h | Run the mock demo locally (`npm install && npm run dev`). Click through all 4 scenarios. Write down anything confusing. Check email/HackerEarth for the Airwallex acceptance notice. | You can explain the demo flow out loud in 2 minutes. |
| **Wed Oct 28** | 2 h | Airwallex sandbox mode: verify auth + listing/creating a transfer against the sandbox with a default beneficiary. Fix the adapter where the real API differs from the mock. | One real sandbox transfer created through the app, with an audit entry. |
| **Thu Oct 29** | **OFF** | Date night. | — |
| **Fri Oct 30** | 1.5 h | PayPal sandbox mode: OAuth token + `POST /v1/payments/payouts` with the `POSPYO001` test note, then `GET` the batch. | One sandbox payout batch visible in the app and in the sandbox business account. |
| **Sat Oct 31** | 3 h | Duplicate-payment hero moment on both connectors: replay the same payout and show the policy engine blocking it before it reaches the API. Add a test for each connector path. | Tests green; second payout never hits the sandbox. |
| **Sun Nov 1** | 3 h | Claude planner: set `ANTHROPIC_API_KEY`, tune the prompt so diagnoses read clearly, confirm fallback to rule-based on errors. (Airwallex lists free Claude tokens for participants; check the hackathon Slack/Discord.) | Planner badge shows Claude; killing the key falls back cleanly. |
| **Mon Nov 2** | 1.5 h | Track 2 (intent-bound purchase): polish the over-limit / off-intent purchase scenario and the approval card wording. | The purchase scenario reads clearly to someone seeing it for the first time. |
| **Tue Nov 3** | 1.5 h | Stuck-transfer + bad-beneficiary scenarios against the sandboxes (use PayPal error test values like `ERRPYO002`; Airwallex sandbox simulation where available). | Each scenario has a sandbox-backed path or is clearly labeled as simulated. |
| **Wed Nov 4** | 2 h | UI polish pass: audit timeline readability, chain-verified badge, empty states. **Feature freeze tonight.** | No new features after this. |
| **Thu Nov 5** | **OFF** | Date night. | — |
| **Fri Nov 6** | 1.5 h | README pass for judges: setup in under 5 minutes, env table, which parts are sandbox vs mock, tools used (Claude), license. | A fresh clone runs from the README alone. |
| **Sat Nov 7** | 3.5 h | Record videos using `DEMO_SCRIPT.md`: the Airwallex cut (~4:30) and the PayPal cut (under 3:00). Do 2 to 3 takes each. | Two raw recordings saved. |
| **Sun Nov 8** | 3 h | Edit videos, add captions, check lengths (PayPal must be under 3:00). Upload PayPal cut to YouTube as Public. Draft both submission texts. | Final videos exported; YouTube link works logged out. |
| **Mon Nov 9** | 1.5 h | Publish repo publicly (GitHub) with MIT license visible; fill the Devpost submission as a **draft** (do not submit yet). Re-check the Devpost profile ("Employed in tech: Yes") is what you want. | Devpost draft complete. |
| **Tue Nov 10** | 1.5 h | **Buffer day.** Fix anything broken. Fill the HackerEarth submission as a draft. | Both drafts complete. |
| **Wed Nov 11** | 1.5 h | **Submit both.** PayPal on Devpost and Airwallex on HackerEarth. Screenshot confirmations. | Two confirmations saved. |
| **Thu Nov 12** | **OFF** | Date night. PayPal deadline is 1:00 PM today, but we are already in. | — |
| Fri Nov 13 | Emergency only | Airwallex closes 11:29 AM. Only touch it if Wednesday's submission failed. | — |

## If you fall behind

Cut in this order, from first to last:
1. Real-sandbox stuck-transfer and bad-beneficiary paths (keep them simulated and label them clearly).
2. Claude planner tuning (the rule-based planner already makes the demo work).
3. UI polish.

Never cut: the duplicate-payment block, the approval queue, the audit log, the README setup steps, or the videos.
