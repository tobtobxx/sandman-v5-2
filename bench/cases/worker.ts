// Worker sessions (§5.7) against the offline corpus. One session each, no verifier.
// Mechanical checks look at the finished result and at harness-recorded tool calls.

import { all, Case, cardWithResult, has } from "../lib.ts";
import { createCard, getCard } from "../../src/work/board.ts";
import { runWorker } from "../../src/work/worker.ts";
import { resultText } from "../../src/work/verifier.ts";
import { db } from "../../src/db.ts";

async function work(card: ReturnType<typeof createCard>) {
  const outcome = await runWorker(card.id);
  const c = getCard(card.id);
  const tools = db().all(`SELECT t.tool, t.args, t.deduplicated FROM tool_calls t JOIN sessions s ON s.id=t.session_id WHERE s.card_id=? ORDER BY t.at`, c.id);
  const arts = db().all(`SELECT * FROM artifacts WHERE card_id=? AND origin='write'`, c.id);
  return { outcome, card: c, result: c.result, text: resultText(c.result), tools, arts, steps: db().get(`SELECT steps FROM sessions WHERE card_id=?`, c.id)?.steps };
}

const ready = (f: Parameters<typeof createCard>[0]) => createCard({ state: "ready" as any, ...f });
const finished = (o: any) => [o.outcome === "finish", `outcome ${o.outcome} (${o.card.state})`] as [boolean, string];
const tools = (o: any) => o.tools.map((t: any) => t.tool).join(",");

function research(name: string, title: string, goal: string, done_when: string[], check: (o: any) => any, judge?: Case["judge"], extra: Record<string, any> = {}): Case {
  return { id: `worker/research-${name}`, run: () => work(ready({ title, goal, done_when, role: "research", ...extra })), check, judge };
}

const KITS = [
  { title: "Detail Gardena Micro-Drip starter set", state: "done", summary: "Gardena Micro-Drip starter set: CHF 89.90, covers about 15 m², 20 drippers at 2 l/h, 5-year guarantee.", facts: [] },
  { title: "Detail Hozelock Easy Drip kit", state: "done", summary: "Hozelock Easy Drip kit: CHF 59.00, covers about 10 m², 15 adjustable drippers (0–8 l/h).", facts: [] },
  { title: "Detail AquaLine Basic kit", state: "done", summary: "AquaLine Basic kit: CHF 34.95, covers about 8 m², 20 drippers. Water use is not published.", facts: [] },
];

const COMPARE_NAMED = "Compare the Gardena Micro-Drip, Hozelock Easy Drip and AquaLine Basic drip kits on price and coverage for 3 raised beds of 4 m² each, and recommend one.";
const COMPARE_OPEN = "Compare drip irrigation kits sold in Switzerland on price and coverage for 3 raised beds of 4 m² each, and recommend one.";
const gatherGoal = (subject: string, request: string) => `Find candidate ${subject} for this request: Compare drip kits. ${request}. List the best ones you find, at most 3; fewer is fine. If the owner named them, list those.`;
const GATHER = { recipe_id: "rcp_research_detail", recipe_step: "gather" };

export const cases: Case[] = [
  research("zoo-hours", "Zoo Zürich winter opening hours", "Find the opening hours of Zoo Zürich in winter.", ["Names the winter opening hours"],
    (o) => all(finished(o), [/17[:.]?00|17 ?h|5 ?pm/i.test(o.text), `no 17:00 in: ${o.text.slice(0, 300)}`], [tools(o).includes("web_fetch"), `never fetched a page: ${tools(o)}`])),
  research("paging", "E-bike repair at Velostation Nord", "Find out whether Velostation Nord at the main station repairs e-bikes and what an e-bike service costs.",
    ["States whether they repair e-bikes", "Names the price of an e-bike service, or states that it is not available"],
    (o) => all(finished(o), [has(o.text, "149"), `price 149 not found (it sits past the first page window): ${o.text.slice(0, 300)}`], [tools(o).includes("read_artifact"), `never paged: ${tools(o)}`])),
  research("price-coverage", "Detail Gardena Micro-Drip starter set", "Find price and coverage for the Gardena Micro-Drip starter set.", ["Covers price and coverage, or states which are not available"],
    (o) => all(finished(o), [has(o.text, "89"), "price missing"], [/15 ?m/i.test(o.text), "coverage missing"])),
  research("facts-subject-rule", "Detail Hozelock Easy Drip kit", "Find price and coverage for the Hozelock Easy Drip kit.", ["Covers price and coverage, or states which are not available"],
    (o) => {
      const facts = o.result?.facts ?? [];
      const badSubj = facts.filter((f: any) => /^(price|cost|coverage|setup|water use|contents)$/i.test(f.subject.trim()));
      const price = facts.find((f: any) => /59/.test(f.claim));
      return all(finished(o), [facts.length > 0, "no facts"], [!badSubj.length, `property as subject: ${badSubj.map((f: any) => f.subject)}`], [!price || price.volatility === "volatile", `price volatility ${price?.volatility}`]);
    }),
  research("not-available-honest", "AquaLine Basic kit water use", "Find the water consumption per dripper (litres per hour) of the AquaLine Basic drip kit.", ["Names the water use per dripper, or states that it is not available"],
    // finishing with "not available" is best; blocking with a sensible question is what the design's walkthrough does
    (o) => all([o.outcome === "finish" || o.outcome === "block", `outcome ${o.outcome}`]),
    { criteria: ["Says that the AquaLine water use is not published or not found (or asks the owner how to proceed because it is missing), and does NOT give a litres-per-hour figure for the AquaLine kit"], material: (o) => o.outcome === "block" ? `Question to the owner: ${db().get(`SELECT text, options FROM questions`)?.text}` : o.text }),
  research("gather-items", "Find candidate drip irrigation kits", "Find up to 3 candidate drip irrigation kits for raised beds sold in Switzerland.", ["Lists up to 3 candidate drip irrigation kits, each with a name and one line why it fits"],
    (o) => {
      const items = o.result?.items ?? [];
      return all(finished(o), [items.length >= 2 && items.length <= 3, `${items.length} items`], [items.filter((i: any) => /gardena|hozelock|aqualine|claber/i.test(i.name)).length >= 2, `items: ${items.map((i: any) => i.name)}`]);
    }, undefined, { recipe_id: "rcp_research_detail", recipe_step: "gather" }),
  // Stages of episode/compare-card and episode/recipe-tree: the gather step with the goal the recipe fills in
  // (copied from traces). Its facts let the librarian answer the detail cards, so they must be there.
  research("gather-named", "Find candidate drip kits", gatherGoal("drip kits", COMPARE_NAMED), ["Lists candidate drip kits (at most 3), each with a name and one line why it fits"],
    (o) => {
      const items = o.result?.items ?? [];
      const named = ["gardena", "hozelock", "aqualine"].filter((k) => items.some((i: any) => i.name.toLowerCase().includes(k)));
      return all(finished(o), [items.length === 3 && named.length === 3, `items: ${items.map((i: any) => i.name)}`], [(o.result?.facts ?? []).length >= 3, `${(o.result?.facts ?? []).length} facts`]);
    }, undefined, GATHER),
  research("gather-open", "Find candidate drip irrigation kits", gatherGoal("drip irrigation kits", COMPARE_OPEN), ["Lists candidate drip irrigation kits (at most 3), each with a name and one line why it fits"],
    (o) => {
      const items = o.result?.items ?? [];
      return all(finished(o), [items.length >= 2 && items.length <= 3, `${items.length} items`], [items.filter((i: any) => /gardena|hozelock|aqualine|claber/i.test(i.name)).length >= 2, `items: ${items.map((i: any) => i.name)}`]);
    }, undefined, GATHER),
  research("closed-sunday", "Library on Sundays", "Find out whether the city library is open on Sundays.", ["States whether it is open on Sundays"],
    (o) => all(finished(o), [/closed|not open|no\b/i.test(o.text), o.text.slice(0, 200)])),
  research("deadline", "Free tax extension deadline", "Find until when a private person in the canton of Zurich can request a free extension of the tax return.", ["Names the deadline"],
    (o) => all(finished(o), [/30 (september|sept|sep)|september 30|30\.0?9/i.test(o.text), o.text.slice(0, 200)])),
  research("heat-pump", "Heat pump noise", "Find how loud a heat pump may be at night at the neighbour's property line.", ["Names the limit in dB(A), or states that it is not available"],
    (o) => all(finished(o), [has(o.text, "45"), o.text.slice(0, 200)])),
  // ---------------------------------------------------------------- write
  {
    id: "worker/write-email",
    run: () => work(ready({ title: "Email to landlord", goal: "Write an email to my landlord, Mr. Keller, asking him to repair the heating in the living room before winter. I'm Alex from flat 3B.", done_when: ["The result includes the email text"], role: "write" })),
    check: (o) => all(finished(o), [o.arts.length === 1, `${o.arts.length} files written`], [(o.arts[0]?.content.match(/\n/g) ?? []).length >= 3, "newlines lost"], [(o.steps ?? 99) <= 3, `took ${o.steps} steps`]),
    judge: { criteria: ["Is a polite email to Mr. Keller asking to repair the heating in the living room before winter", "Contains no placeholders like [Your Name] or [Date]"], material: (o) => o.arts[0]?.content ?? "(no file)" },
  },
  {
    id: "worker/write-uses-inputs",
    run: async () => {
      const src = cardWithResult({ title: "Tax extension rules Zurich", state: "done", result: { summary: "Free extension until 30 September via the online portal; a further extension to 30 November costs CHF 20 and must be requested before 30 September. An accountant can request it." } });
      return work(ready({ title: "Email to accountant", goal: "Write a short email to my accountant, Ms. Brunner, asking her to request the tax extension for me.", done_when: ["The result includes the email text"], role: "write", inputs: [`card:${src.id}`] }));
    },
    check: (o) => all(finished(o), [o.arts.length >= 1, "no file"]),
    judge: { criteria: ["Asks Ms. Brunner to request the tax extension and mentions a correct deadline (30 September or 30 November)"], material: (o) => o.arts[0]?.content ?? "(no file)" },
  },
  // ---------------------------------------------------------------- synthesize
  {
    id: "worker/synthesize-recommend",
    run: async () => {
      const parent = ready({ title: "Compare drip kits", goal: "Compare the Gardena, Hozelock and AquaLine drip kits on price and coverage for 3 raised beds of 4 m² each (12 m² in total), and recommend one.", done_when: ["Names price and coverage of each kit", "Recommends one kit and says why"], role: "synthesize" });
      db().update("cards", parent.id, { phase: "synthesize" });
      for (const k of KITS) {
        const ch = createCard({ parent_id: parent.id, title: k.title, state: "ready" as any });
        db().update("cards", ch.id, { state: k.state, result: { summary: k.summary, facts: k.facts } });
      }
      return work(getCard(parent.id));
    },
    check: (o) => all(finished(o), [!!o.result?.recommendation, "no recommendation"], [/gardena|hozelock|aqualine/i.test(o.result?.recommendation ?? ""), "recommendation names no kit"]),
    judge: {
      criteria: ["Names price and coverage for all three kits", "Recommends exactly one kit with a reason that fits 12 m² of beds (only Gardena covers 12 m² with one set; others would need several)"],
      material: (o) => o.text,
    },
  },
  {
    id: "worker/synthesize-with-failed-child",
    run: async () => {
      const parent = ready({ title: "Compare drip kits", goal: "Compare the Gardena and Rainmaster drip kits on price and recommend one.", done_when: ["Names the price of each kit, or states that it is not available", "Recommends one kit"], role: "synthesize" });
      db().update("cards", parent.id, { phase: "synthesize" });
      const a = createCard({ parent_id: parent.id, title: "Detail Gardena Micro-Drip starter set", state: "ready" as any });
      db().update("cards", a.id, { state: "done", result: { summary: "Gardena Micro-Drip starter set costs CHF 89.90 and covers 15 m²." } });
      const b = createCard({ parent_id: parent.id, title: "Detail Rainmaster kit", state: "ready" as any });
      db().update("cards", b.id, { state: "failed", result: { summary: "", reason: "No shop or manufacturer page for a 'Rainmaster' drip kit was found." } });
      return work(getCard(parent.id));
    },
    check: (o) => all(finished(o)),
    judge: { criteria: ["Says that no information was found for the Rainmaster kit, without inventing a price for it"], material: (o) => o.text },
  },
];
