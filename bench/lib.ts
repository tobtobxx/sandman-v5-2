// Benchmark harness: small, isolated cases per role, each against a fresh in-memory database.
// Validation is mechanical where possible; otherwise an LLM judge (profile "judge") checks criteria.

import { db, nowIso, Row } from "../src/db.ts";
import { llmJson } from "../src/llm/gateway.ts";
import { obj, oneOf, str } from "../src/llm/schema.ts";
import { createTopic } from "../src/conversation/topics.ts";
import { createCard, getCard, transition } from "../src/work/board.ts";
import { createQuestion } from "../src/conversation/questions.ts";
import { addClaim, createNote } from "../src/memory/consolidator.ts";

export type Check = { pass: boolean; detail?: string };

export interface Case {
  id: string; // "<group>/<name>"
  desc?: string;
  run: () => Promise<any>;
  /** mechanical check */
  check?: (out: any) => Check | boolean | Promise<Check | boolean>;
  /** LLM-judged criteria, over text built from the output */
  judge?: { criteria: string[]; material: (out: any) => string };
}

export const group = (c: Case) => c.id.split("/")[0];

// ---- fixed clock: Tuesday 29 Sep 2026, 08:14 in Zurich ----
export const NOW = new Date("2026-09-29T06:14:00Z");
export const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86400e3).toISOString();

// ---- fixtures ----
export function topic(title: string, summary = "") {
  return createTopic(title, summary);
}

export function cardWithResult(t: { topic_id?: string; title: string; goal?: string; state?: string; result?: Row; role?: string; done_when?: string[] }) {
  const c = createCard({ title: t.title, goal: t.goal ?? t.title, origin_topic_id: t.topic_id, role: t.role ?? "research", done_when: t.done_when ?? [], state: "ready" as any });
  if (t.result) db().update("cards", c.id, { result: t.result, result_source: "worker" });
  if (t.state && t.state !== "ready") db().update("cards", c.id, { state: t.state });
  return getCard(c.id);
}

export function blockedCard(t: { topic_id: string; title: string; question: string; options: string[]; reason?: string }) {
  const c = createCard({ title: t.title, origin_topic_id: t.topic_id, state: "ready" as any });
  transition(c.id, "running", "claimed");
  const q = createQuestion({ card_id: c.id, topic_id: t.topic_id, text: t.question, options: t.options, reason: t.reason ?? "worker_question" });
  transition(c.id, "blocked", "block", "worker", { blocked_reason: t.reason ?? "worker_question" });
  return { card: getCard(c.id), question: q };
}

export function note(title: string, claims: { text: string; days_ago: number; volatility: string; source?: Row }[], kind = "entity") {
  const n = createNote(kind, title);
  for (const c of claims) addClaim(n.id, { text: c.text, volatility: c.volatility, source: c.source ?? { type: "url", ref: "https://www.velostation-nord.ch/about" }, observed_at: daysAgo(c.days_ago) });
  return n;
}

export const receiptsOf = (turn_id: string) => db().all(`SELECT * FROM receipts WHERE desk_turn_id=?`, turn_id);
export const has = (s: unknown, ...words: string[]) => words.every((w) => String(s ?? "").toLowerCase().includes(w.toLowerCase()));
export const all = (...checks: [boolean, string][]): Check => {
  const bad = checks.filter(([ok]) => !ok).map(([, d]) => d);
  return { pass: !bad.length, detail: bad.join("; ") || undefined };
};

// ---- judge ----
export async function judge(criteria: string[], material: string): Promise<Check> {
  const fails: string[] = [];
  for (const criterion of criteria) {
    const r = await llmJson<{ analysis: string; verdict: string }>(
      "judge",
      `You grade the output of an AI assistant in a test. Judge only what is shown. Be strict but fair:
a criterion passes if a reasonable reader would say the output meets it.

Criterion: "${criterion}"

Output:
${material}

Reply with analysis (at most 40 words), then verdict: pass or fail.`,
      obj({ analysis: str(400), verdict: oneOf(["pass", "fail"]) }),
      { maxTokens: 400, profile: "judge", temperature: 0 },
    );
    if (r.verdict !== "pass") fails.push(`judge: "${criterion}" — ${r.analysis}`);
  }
  return { pass: !fails.length, detail: fails.join("; ") || undefined };
}

export { nowIso };

/** Every real deployment has an owner profile (§7.2); cases run with this one. */
export function ownerProfile() {
  note("Alex (profile)", [
    { text: "Alex lives in Zurich, Switzerland.", days_ago: 60, volatility: "slow", source: { type: "owner", ref: "setup" } },
    { text: "Alex prefers low-maintenance options.", days_ago: 30, volatility: "slow", source: { type: "owner", ref: "setup" } },
  ], "profile");
}
