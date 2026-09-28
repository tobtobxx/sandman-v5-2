// Consolidator (§7.5) and owner-fact extraction (§7.4).

import { all, Case, daysAgo, note, topic } from "../lib.ts";
import { db, nowIso } from "../../src/db.ts";
import { newId } from "../../src/ids.ts";
import { consolidateOne, relevant, resolveSubject } from "../../src/memory/consolidator.ts";
import { extractFacts } from "../../src/conversation/pages.ts";
import { postMessage } from "../../src/conversation/messages.ts";

function fact(subject: string, text: string, volatility = "slow", source: Record<string, any> = { type: "url", ref: "https://www.gardena-shop.ch/micro-drip-starter-set" }) {
  const f = { id: newId("fct"), subject, text, source: JSON.stringify(source), volatility, status: "pending", created_at: nowIso() };
  db().insert("facts", f);
  return f;
}

const gardena = () =>
  note("Gardena Micro-Drip starter set", [
    { text: "The Gardena Micro-Drip starter set covers about 15 m² of raised bed.", days_ago: 30, volatility: "slow" },
    { text: "The Gardena Micro-Drip starter set costs CHF 79.90.", days_ago: 200, volatility: "volatile" },
  ]);

function decide(name: string, setup: () => void, f: () => any, want: string): Case {
  return {
    id: `memory/${name}`,
    run: async () => {
      setup();
      const x = f();
      const d = await consolidateOne(x);
      return { d, fact: db().get(`SELECT * FROM facts WHERE id=?`, x.id) };
    },
    check: (o) => ({ pass: o.d === want, detail: `decision ${o.d}, want ${want}: ${o.fact.decision_analysis ?? ""}` }),
  };
}

function subject(name: string, setup: () => void, subj: string, claim: string, wantTitle: string | null): Case {
  return {
    id: `memory/subject-${name}`,
    run: async () => {
      setup();
      return await resolveSubject(fact(subj, claim));
    },
    check: (o) => wantTitle === null
      ? { pass: o.created, detail: `matched existing note "${o.note.title}"` }
      : { pass: !o.created && o.note.title === wantTitle, detail: `got "${o.note.title}" (${o.via})` },
  };
}

function rel(name: string, subj: string, claim: string, keep: boolean, source = "https://www.velostation-nord.ch/about"): Case {
  return {
    id: `memory/relevance-${name}`,
    run: () => relevant(fact(subj, claim, "slow", { type: "url", ref: source })),
    check: (o) => ({ pass: o.keep === keep, detail: `keep=${o.keep}: ${JSON.stringify(o.rubric)}` }),
  };
}

export const cases: Case[] = [
  subject("same-thing-other-words", gardena, "Gardena drip starter kit", "One set has 20 drippers.", "Gardena Micro-Drip starter set"),
  subject("same-kind-different-thing", gardena, "Gardena Micro-Drip extension set", "The extension set adds 10 drippers.", null),
  subject("different-brand", gardena, "Hozelock Easy Drip kit", "The Hozelock kit covers about 10 m².", null),
  rel("task-mechanics", "Velostation Nord", "The page was found with a web search and read in two parts.", false),
  rel("trivial", "Switzerland", "The capital of Switzerland is Bern.", false, "https://www.admin.ch/gov/en/start.html"),
  rel("reusable-price", "Velostation Nord", "An e-bike service at Velostation Nord costs CHF 149.", true),
  decide("duplicate", gardena, () => fact("Gardena Micro-Drip starter set", "One Gardena Micro-Drip starter set waters about 15 square metres.", "slow"), "duplicate"),
  decide("update-price", gardena, () => fact("Gardena Micro-Drip starter set", "The Gardena Micro-Drip starter set costs CHF 89.90.", "volatile"), "update"),
  decide("unrelated-detail-not-update", () => note("Velostation Nord", [
    { text: "An e-bike service at Velostation Nord costs CHF 149, which includes a software update and a battery check.", days_ago: 0, volatility: "volatile" },
  ]), () => fact("Velostation Nord", "Velostation Nord does not repair batteries themselves but sends them to the manufacturer.", "slow", { type: "url", ref: "https://www.velostation-nord.ch/about" }), "new"),
  decide("new-claim", gardena, () => fact("Gardena Micro-Drip starter set", "Each Gardena Micro-Drip dripper delivers 2 litres per hour.", "slow"), "new"),
  {
    id: "memory/owner-facts-only-statements",
    run: async () => {
      const t = topic("Raised bed irrigation");
      const msgs = [
        "I prefer low-maintenance options, I travel a lot in summer.",
        "please find a drip kit for the beds",
        "my balcony faces south and gets very hot",
        "how much would that cost?",
      ].map((body) => postMessage({ topic_id: t.id, role: "owner", kind: "text", body }));
      return await extractFacts(t.id, msgs);
    },
    check: (o) => all(
      [o.length >= 2 && o.length <= 3, `${o.length} facts: ${JSON.stringify(o.map((f: any) => f.claim))}`],
      [o.some((f: any) => /maintenance/i.test(f.claim)), "missed the preference"],
      [o.some((f: any) => /south|balcony/i.test(f.claim)), "missed the balcony"],
      [!o.some((f: any) => /find|cost/i.test(f.claim) && !/maintenance|balcony/i.test(f.claim)), "turned a request into a fact"],
    ),
  },
  {
    id: "memory/owner-facts-none",
    run: async () => {
      const t = topic("Bike");
      const msgs = ["find out if the bike shop repairs e-bikes", "thanks!", "what did it cost again?"].map((body) => postMessage({ topic_id: t.id, role: "owner", kind: "text", body }));
      return await extractFacts(t.id, msgs);
    },
    check: (o) => ({ pass: o.length === 0, detail: JSON.stringify(o) }),
  },
];

export { daysAgo };
