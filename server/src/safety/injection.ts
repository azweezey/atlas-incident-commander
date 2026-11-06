/**
 * Untrusted-text guard. Incident data (provider notes, memo fields, vendor emails) is data,
 * never instructions. If it contains instruction-like text aimed at the agent, every
 * money-moving action derived from that incident is denied (read-only actions still run).
 */
const PATTERNS: [RegExp, string][] = [
  [/\bignore\s+(all\s+|your\s+|the\s+|any\s+)?(previous\s+|prior\s+)?(rules|instructions|policy|policies|guardrails)\b/i, "asks the agent to ignore its rules"],
  [/\b(disregard|bypass|override|skip)\s+(the\s+|your\s+|all\s+)?(rules|policy|policies|guardrails|approval|limits?|checks?)\b/i, "asks the agent to bypass policy"],
  [/\b(re-?send|re-?pay|pay\s+again|send\s+again|retry)\b.{0,40}\b(payment|payout|transfer|invoice)\b/i, "instructs a repeat payment"],
  [/\b(you\s+are\s+now|act\s+as|new\s+instructions|system\s*(prompt|note|override))\b/i, "tries to re-role the agent"],
  [/\b(without|no)\s+(human\s+)?(approval|review|sign-?off)\b/i, "asks to skip human approval"],
];

export interface InjectionScan {
  flagged: boolean;
  findings: string[];
}

export function scanUntrusted(...texts: (string | undefined)[]): InjectionScan {
  const findings: string[] = [];
  for (const t of texts) {
    if (!t) continue;
    for (const [re, why] of PATTERNS) if (re.test(t) && !findings.includes(why)) findings.push(why);
  }
  return { flagged: findings.length > 0, findings };
}
