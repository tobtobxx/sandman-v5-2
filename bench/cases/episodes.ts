// Episodes: whole pipelines through the real harness (DESIGN §14.3), mapped to milestone acceptance tests.

import { all, Case, cardWithResult, has, topic } from "../lib.ts";
import { db, j } from "../../src/db.ts";
import { processCapture, receiveCapture, moveItem } from "../../src/conversation/capture.ts";
import { undoReceipt } from "../../src/conversation/receipts.ts";
import { createCard, getCard, children } from "../../src/work/board.ts";
import { runTree } from "../../src/work/dispatcher.ts";
import { runPlanner } from "../../src/work/preflight.ts";
import { consolidate } from "../../src/memory/consolidator.ts";
import { zoned } from "../../src/conversation/when.ts";

function irrigationWorld() {
  const irr = topic("Raised bed irrigation", "Comparing drip irrigation kits for the three raised beds in the garden.");
  const tax = topic("Taxes 2026", "Tax return 2026: deadlines, accountant, extension.");
  const running = cardWithResult({ topic_id: irr.id, title: "Compare drip kits", goal: "Compare drip irrigation kits for 3 raised beds", state: "running" });
  return { irr, tax, running };
}

const M3_CAPTURE = "garden: the kit must also reach the balcony pots, remind me Friday to file the tax extension, and find out if the bike shop repairs e-bikes";

export const cases: Case[] = [
  {
    id: "episode/capture-three-items",
    desc: "M3 accept 1: 3 items, 3 topics, 3 correct actions, one confirmation naming all three",
    run: async () => {
      const w = irrigationWorld();
      const cap = receiveCapture({ text: M3_CAPTURE });
      const r = await processCapture(cap.id);
      return { w, r, receipts: db().all(`SELECT r.*, t.slug FROM receipts r JOIN topics t ON t.id=r.topic_id`) };
    },
    check: (o) => {
      const by = (k: string) => o.receipts.filter((r: any) => r.kind === k);
      const rem = by("reminder_set")[0];
      const remCard = rem ? getCard(rem.ref_id) : null;
      return all(
        [o.r.items.length === 3, `${o.r.items.length} items`],
        [o.receipts.length === 3, `receipts: ${o.receipts.map((r: any) => `${r.kind}@${r.slug}`).join(", ")}`],
        [by("added_to_card").some((r: any) => r.ref_id === o.w.running.id), "balcony not added to the running card"],
        [!!rem && rem.topic_id === o.w.tax.id && !!remCard && zoned(new Date(remCard.due_at!)).d === 2, "reminder missing / wrong topic / wrong day"],
        [by("card_created").some((r: any) => r.topic_id !== o.w.irr.id && r.topic_id !== o.w.tax.id), "e-bike card missing or in an old topic"],
        [/balcony|drip/i.test(o.r.confirmation.text) && /remind/i.test(o.r.confirmation.text) && /bike/i.test(o.r.confirmation.text), `confirmation: ${o.r.confirmation.text}`],
      );
    },
  },
  {
    id: "episode/undo-new-card",
    desc: "M3 accept 4: undoing a 'new card' receipt cancels the card",
    run: async () => {
      topic("Bike maintenance", "City bike and e-bike");
      const r = await processCapture(receiveCapture({ text: "find out if the bike shop near the station repairs e-bikes" }).id);
      const rc = r.items[0]?.desk.receipts[0];
      const u = rc ? undoReceipt(rc.id) : null;
      return { rc, u, card: rc ? getCard(rc.ref_id) : null };
    },
    check: (o) => all([o.rc?.kind === "card_created", `receipt ${o.rc?.kind}`], [o.u?.ok === true, JSON.stringify(o.u)], [o.card?.state === "cancelled", `card ${o.card?.state}`]),
  },
  {
    id: "episode/move-item-reparents",
    desc: "M3 accept 7: moving an item re-parents its card and reminder",
    run: async () => {
      const a = topic("Holiday Portugal", "Two weeks in Portugal in October");
      const b = topic("Garden", "Vegetable garden");
      const r = await processCapture(receiveCapture({ text: "find out when to plant garlic in Zurich and remind me on Sunday to buy compost" }).id);
      const it = r.items[0];
      const target = it.route.topic_id === b.id ? a : b;
      moveItem(it.item_id, target.id);
      const refs = db().all(`SELECT ref_id FROM receipts WHERE capture_item_id=?`, it.item_id).map((x) => getCard(x.ref_id));
      return { target, refs, items: r.items.length };
    },
    check: (o) => all([o.refs.length >= 1, "no receipts"], [o.refs.every((c: any) => c.origin_topic_id === o.target.id), "card or reminder not moved"]),
  },
  {
    id: "episode/research-card",
    desc: "librarian → triage → worker → verifier on a paging task",
    run: async () => {
      const t = topic("Bike maintenance");
      const c = createCard({ title: "E-bike repair at Velostation Nord", goal: "Find out whether Velostation Nord at the main station repairs e-bikes and what an e-bike service costs.", done_when: ["States whether they repair e-bikes", "Names the price of an e-bike service, or states that it is not available"], origin_topic_id: t.id });
      const r = await runTree(c.id);
      return { card: r, msg: db().get(`SELECT * FROM messages WHERE kind='card_result'`) };
    },
    check: (o) => all([o.card.state === "done", `state ${o.card.state}`], [has(o.card.result?.summary, "149"), `summary: ${o.card.result?.summary}`], [!!o.msg, "no card_result message"]),
  },
  {
    id: "episode/write-card",
    desc: "M1 accept 2: a write card produces a multi-paragraph file with intact newlines",
    run: async () => {
      const t = topic("Flat");
      const c = createCard({ role: "write", title: "Email to landlord", goal: "Write an email to my landlord, Mr. Keller, asking him to repair the heating in the living room before winter. I'm Alex from flat 3B.", done_when: ["The result includes the email text"], origin_topic_id: t.id });
      const r = await runTree(c.id);
      return { card: r, art: db().get(`SELECT * FROM artifacts WHERE card_id=? AND origin='write'`, c.id) };
    },
    check: (o) => all([o.card.state === "done", `state ${o.card.state}`], [(o.art?.content.match(/\n\s*\n/g) ?? []).length >= 2, "not multi-paragraph"]),
  },
  {
    id: "episode/compare-card",
    desc: "a compare task end to end; triage decides whether to split (DESIGN §19 open question 1)",
    run: async () => {
      const t = topic("Raised bed irrigation");
      const c = createCard({
        title: "Compare drip kits", origin_topic_id: t.id,
        goal: "Compare the Gardena Micro-Drip, Hozelock Easy Drip and AquaLine Basic drip kits on price and coverage for 3 raised beds of 4 m² each, and recommend one.",
        done_when: ["Names price and coverage of each kit, or states which are not available", "Recommends one kit and says why"],
      });
      const r = await runTree(c.id, 80, 4);
      return { card: r, kids: children(c.id) };
    },
    check: (o) => all(
      [o.card.state === "done", `state ${o.card.state}`],
      [/gardena/i.test((o.card.result?.recommendation ?? "") + (o.card.result?.summary ?? "")), `result: ${o.card.result?.recommendation ?? o.card.result?.summary}`],
    ),
  },
  {
    id: "episode/recipe-tree",
    desc: "M2 accept 1: planner → gather → one detail card per kit → synthesis, no duplicate compare step",
    run: async () => {
      const t = topic("Raised bed irrigation");
      const c = createCard({
        title: "Compare drip kits", origin_topic_id: t.id,
        goal: "Compare drip irrigation kits sold in Switzerland on price and coverage for 3 raised beds of 4 m² each, and recommend one.",
        done_when: ["Names price and coverage of each kit, or states which are not available", "Recommends one kit and says why"],
      });
      await runPlanner(getCard(c.id)); // forced split: this case tests the tree, not triage
      const r = await runTree(c.id, 80, 4);
      return { card: r, kids: children(c.id), calls: db().get(`SELECT llm_calls_used n FROM cards WHERE id=?`, c.id)!.n };
    },
    check: (o) => all(
      [o.card.recipe_id === "rcp_research_detail", `recipe ${o.card.recipe_id}`],
      [o.kids.filter((k: any) => k.recipe_step === "detail").length >= 2, `children: ${o.kids.map((k: any) => `${k.recipe_step}:${k.title}:${k.state}`).join(" | ")}`],
      [!o.kids.some((k: any) => /compare|recommend/i.test(k.title)), "a child duplicates the compare step"],
      [o.card.state === "done", `state ${o.card.state}`],
      [!!o.card.result?.recommendation, `recommendation: ${o.card.result?.recommendation}`],
      [o.calls <= 40, `${o.calls} calls`],
    ),
  },
  {
    id: "episode/memory-reuse",
    desc: "M4 accept 1: a question researched earlier is answered from memory with zero worker steps",
    run: async () => {
      const t = topic("Bike maintenance");
      const goal = "Find out whether Velostation Nord at the main station repairs e-bikes and what an e-bike service costs.";
      const done_when = ["States whether they repair e-bikes", "Names the price of an e-bike service, or states that it is not available"];
      const first = await runTree(createCard({ title: "E-bike repair at Velostation Nord", goal, done_when, origin_topic_id: t.id }).id);
      const cons = await consolidate();
      const second = createCard({ title: "E-bike service cost", goal: "What does an e-bike service at Velostation Nord cost, and do they do e-bikes at all?", done_when, origin_topic_id: t.id });
      const r = await runTree(second.id);
      const workerSessions = db().get(`SELECT count(*) n FROM sessions WHERE card_id=? AND type='worker'`, second.id)!.n;
      return { first, cons, second: r, workerSessions, notes: db().all(`SELECT title FROM notes`).map((n) => n.title) };
    },
    check: (o) => all(
      [o.first.state === "done", `first card ${o.first.state}`],
      [o.second.state === "done" && o.second.result_source === "memory", `second: ${o.second.state}, source ${o.second.result_source}; notes ${o.notes.join(", ")}; consolidation ${JSON.stringify(o.cons)}`],
      [o.workerSessions === 0, `${o.workerSessions} worker sessions`],
    ),
  },
];

export { j };
