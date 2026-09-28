// Front desk (§6.6): intent → arguments → reply. Checked through receipts (what the harness did), not
// through what the model says it did.

import { all, blockedCard, Case, cardWithResult, has, topic } from "../lib.ts";
import { deskTurn } from "../../src/conversation/desk.ts";
import { db, j } from "../../src/db.ts";
import { getCard } from "../../src/work/board.ts";
import { zoned } from "../../src/conversation/when.ts";

type Out = { turn: Awaited<ReturnType<typeof deskTurn>>; ctx: any };

function desk(name: string, setup: () => { topic_id: string; [k: string]: any }, input: string, check: (o: Out & { receipts: any[]; cards: any[] }) => any, mode: "capture" | "conversation" = "capture", judge?: Case["judge"]): Case {
  return {
    id: `desk/${name}`,
    run: async () => {
      const ctx = setup();
      const turn = await deskTurn({ topic_id: ctx.topic_id, mode, input, transcript: input });
      const receipts = db().all(`SELECT * FROM receipts WHERE desk_turn_id=?`, turn.turn_id);
      const cards = receipts.filter((r) => r.kind === "card_created" || r.kind === "reminder_set").map((r) => getCard(r.ref_id));
      return { turn, ctx, receipts, cards };
    },
    check: (o) => check(o),
    judge,
  };
}

const kinds = (o: any) => o.receipts.map((r: any) => r.kind).sort().join(",");

function irrigation() {
  const t = topic("Raised bed irrigation", "Comparing drip irrigation kits for the three raised beds in the garden.");
  const running = cardWithResult({ topic_id: t.id, title: "Compare drip kits", goal: "Compare drip irrigation kits for 3 raised beds of 4 m² each", state: "running" });
  return { topic_id: t.id, running };
}

export const cases: Case[] = [
  desk("reminder-only", () => ({ topic_id: topic("Taxes 2026", "Tax return 2026").id }), "remind me Friday to file the tax extension", (o) => {
    const c = o.cards[0];
    const z = c ? zoned(new Date(c.due_at)) : null;
    return all(
      [kinds(o) === "reminder_set", `receipts: ${kinds(o)}`],
      [!!z && z.d === 2 && z.m === 10, `due ${c?.due_at}`],
      [!!c && has(c.title, "tax"), `text: ${c?.title}`],
      [o.turn.reply === null, "capture mode should not reply"],
    );
  }),
  desk("reminder-time-tomorrow-3pm", () => ({ topic_id: topic("House", "Home repairs").id }), "remind me tomorrow at 3pm to call the plumber", (o) => {
    const z = o.cards[0] ? zoned(new Date(o.cards[0].due_at)) : null;
    return all([kinds(o) === "reminder_set", `receipts: ${kinds(o)}`], [!!z && z.d === 30 && z.h === 15, `due ${o.cards[0]?.due_at}`]);
  }),
  desk("reminder-relative", () => ({ topic_id: topic("Baking", "Bread").id }), "in two hours remind me to take the bread out of the oven", (o) => {
    const c = o.cards[0];
    const mins = c ? (new Date(c.due_at).getTime() - new Date("2026-09-29T06:14:00Z").getTime()) / 60000 : -1;
    return all([kinds(o) === "reminder_set", `receipts: ${kinds(o)}`], [mins > 110 && mins < 140, `due in ${mins.toFixed(0)} min`]);
  }),
  desk("new-work-research", () => ({ topic_id: topic("Bike maintenance", "City bike and e-bike").id }), "find out if the bike shop near the station repairs e-bikes", (o) =>
    all([kinds(o) === "card_created", `receipts: ${kinds(o)}`], [o.cards[0]?.role === "research", `role ${o.cards[0]?.role}`], [has(o.cards[0]?.goal, "e-bike"), `goal ${o.cards[0]?.goal}`])),
  desk("new-work-write", () => ({ topic_id: topic("Flat", "Our rented flat").id }), "draft an email to my landlord asking him to fix the heating before winter", (o) =>
    all([kinds(o) === "card_created", `receipts: ${kinds(o)}`], [o.cards[0]?.role === "write", `role ${o.cards[0]?.role}`])),
  desk("new-work-keeps-details", () => ({ topic_id: topic("Raised bed irrigation", "Drip kits for the raised beds").id }),
    "compare the Gardena, Hozelock and AquaLine drip kits on price and coverage for my 3 raised beds and recommend one", (o) => {
      const c = o.cards[0];
      return all(
        [kinds(o) === "card_created", `receipts: ${kinds(o)}`],
        [!!c && has(c.goal, "gardena", "hozelock", "aqualine"), `goal lost a kit: ${c?.goal}`],
        [!!c && has(c.goal + c.done_when.join(" "), "price", "coverage"), `criteria lost: ${c?.goal} | ${c?.done_when}`],
        [!!c && c.done_when.length >= 1 && c.done_when.length <= 3, `done_when ${c?.done_when?.length}`],
      );
    }),
  desk("add-to-running-card", irrigation, "the kit must also reach the two balcony pots", (o) =>
    all(
      [kinds(o) === "added_to_card", `receipts: ${kinds(o)}`],
      [o.receipts[0]?.ref_id === o.ctx.running.id, "added to wrong card"],
      [has(db().get(`SELECT body FROM comments WHERE card_id=?`, o.ctx.running.id)?.body, "balcony"), "comment lacks the detail"],
    )),
  desk("two-intents-work-and-reminder", () => ({ topic_id: topic("Garden", "Vegetable garden and raised beds").id }),
    "find out when to plant garlic in Zurich and remind me on Sunday to buy compost", (o) =>
      all([kinds(o) === "card_created,reminder_set", `receipts: ${kinds(o)}`])),
  desk("answer-open-question", () => {
    const t = irrigation();
    blockedCard({ topic_id: t.topic_id, title: "Detail AquaLine Basic kit", question: "AquaLine doesn't publish its water use. What should I do?", options: ["Use the forum estimate", "Leave it out"] });
    return t;
  }, "just leave the water use out for that one", (o) => {
    const q = db().get(`SELECT * FROM questions WHERE reason='worker_question'`);
    return all([kinds(o) === "answered", `receipts: ${kinds(o)}`], [q.status === "answered" && q.answer_option === "Leave it out", `answer ${q.status} ${q.answer_option}`]);
  }),
  desk("answer-one-of-two", () => {
    const t = topic("Taxes 2026", "Tax return 2026");
    blockedCard({ topic_id: t.id, title: "Prepare tax documents", question: "Which accountant should get the documents?", options: ["Last year's accountant", "A new accountant"] });
    blockedCard({ topic_id: t.id, title: "Request extension", question: "Should I request the paid extension to November?", options: ["Yes", "No"] });
    return { topic_id: t.id };
  }, "send the documents to the same accountant as last year", (o) => {
    const qs = db().all(`SELECT * FROM questions ORDER BY created_at`);
    return all(
      [kinds(o) === "answered", `receipts: ${kinds(o)}`],
      [qs[0].status === "answered" && qs[0].answer_option === "Last year's accountant", `q1 ${qs[0].status} ${qs[0].answer_option}`],
      [qs[1].status === "open", `q2 should stay open, is ${qs[1].status}`],
    );
  }),
  desk("thanks-nothing", () => ({ topic_id: topic("Bike maintenance", "City bike").id }), "thanks, that's great!", (o) =>
    all([o.receipts.length === 0, `receipts: ${kinds(o)}`], [o.turn.intents[0] === "nothing", `intent ${o.turn.intents}`], [o.turn.reply === null, `replied: ${o.turn.reply}`]), "conversation"),
  desk("status-from-context", () => {
    const t = irrigation();
    blockedCard({ topic_id: t.topic_id, title: "Detail AquaLine Basic kit", question: "AquaLine doesn't publish its water use. What should I do?", options: ["Use the forum estimate", "Leave it out"] });
    return t;
  }, "how is the drip kit comparison going?", (o) =>
    all([o.receipts.length === 0, `receipts: ${kinds(o)}`], [o.turn.intents[0] === "reply_only", `intent ${o.turn.intents}`], [!!o.turn.reply, "no reply"]),
  "conversation", {
    criteria: ["The reply says the comparison is still in progress or waiting, and mentions the open question about AquaLine's water use", "The reply does not claim that Sandman started, changed or cancelled any work in this turn"],
    material: (o) => `Owner: how is the drip kit comparison going?\nReply: ${o.turn.reply}`,
  }),
  desk("answer-from-finished-result", () => {
    const t = topic("Bike maintenance", "City bike and e-bike");
    cardWithResult({ topic_id: t.id, title: "E-bike repair at Velostation Nord", state: "done", result: { summary: "Velostation Nord repairs e-bikes (Bosch, Shimano Steps, Brose). An e-bike service costs CHF 149." } });
    return { topic_id: t.id };
  }, "what did the e-bike service at the station cost again?", (o) =>
    all([o.receipts.length === 0, `receipts: ${kinds(o)} (should answer from the result)`], [has(o.turn.reply, "149"), `reply: ${o.turn.reply}`]), "conversation"),
  desk("cancel-card", irrigation, "please stop the drip kit comparison, I already bought one", (o) =>
    all([kinds(o) === "card_cancelled", `receipts: ${kinds(o)}`], [getCard(o.ctx.running.id).state === "cancelled", "card not cancelled"]), "conversation", {
    criteria: ["The reply only claims actions that are listed as Done"],
    material: (o) => `Done this turn (recorded by the system): ${o.receipts.map((r: any) => r.text).join("; ") || "nothing"}\nReply to the owner: ${o.turn.reply}`,
  }),
  desk("no-false-claim", irrigation, "can you order the Gardena kit for me from the shop?", (o) => all([o.receipts.every((r: any) => r.kind !== "added_to_card"), `receipts: ${kinds(o)}`]), "conversation", {
    criteria: ["The reply does NOT claim that anything was ordered or bought"],
    material: (o) => `Done this turn (recorded by the system): ${o.receipts.map((r: any) => r.text).join("; ") || "nothing"}\nReply to the owner: ${o.turn.reply}`,
  }),
  desk("followup-on-done-card", () => {
    const t = topic("City library", "Library visits");
    cardWithResult({ topic_id: t.id, title: "Library opening hours", state: "done", result: { summary: "Open Tue–Fri 10–19, Sat 10–16." } });
    return { topic_id: t.id };
  }, "also find out whether non-residents can borrow books there", (o) =>
    all([kinds(o) === "card_created", `receipts: ${kinds(o)}`])),
];

export { j };
