// Segmenter (§6.3): split a capture into items, each quoting its own words.
// Mechanical: number of items, and each expected keyword lands in exactly one item.

import { Case } from "../lib.ts";
import { segment } from "../../src/conversation/capture.ts";

function seg(name: string, text: string, expect: string[][], opts: { exact?: boolean; uncovered?: number } = {}): Case {
  return {
    id: `segment/${name}`,
    run: () => segment(text),
    check: (o) => {
      const items: string[] = o.items.map((s: string) => s.toLowerCase());
      if (opts.exact !== false && items.length !== expect.length) return { pass: false, detail: `${items.length} items, want ${expect.length}: ${JSON.stringify(o.items)}` };
      for (const kws of expect) {
        const hits = items.filter((i) => kws.every((k) => i.includes(k)));
        if (hits.length !== 1) return { pass: false, detail: `"${kws.join(" ")}" in ${hits.length} items: ${JSON.stringify(o.items)}` };
      }
      if (opts.uncovered !== undefined && o.uncovered.length !== opts.uncovered) return { pass: false, detail: `uncovered ${JSON.stringify(o.uncovered)}` };
      return true;
    },
  };
}

export const cases: Case[] = [
  seg("three-subjects-one-sentence",
    "garden: the kit must also reach the balcony pots, remind me Friday to file the tax extension, and find out if the bike shop repairs e-bikes",
    [["balcony"], ["tax"], ["e-bike"]]),
  seg("voice-memo-with-filler",
    "Garden: the drip kit also needs to reach the two balcony pots. Uh, and remind me Friday to file the tax extension. Oh, and can you find out if the bike shop near the station repairs e-bikes.",
    [["balcony"], ["tax"], ["e-bike"]], { uncovered: 0 }),
  seg("two-items-question",
    "Remind me to call the plumber tomorrow and also what was the name of that tile shop we liked",
    [["plumber"], ["tile"]]),
  seg("one-long-subject",
    "I've been thinking about the raised beds. The soil seems very compact and I think we should add compost and maybe some sand before planting the garlic in October, so please look into how much compost three beds of 1.2 by 3 metres need.",
    [["compost"]]),
  seg("one-request-with-details",
    "Find a good dentist near Oerlikon who takes new patients, ideally one who speaks English and has appointments on Saturdays.",
    [["dentist"]]),
  seg("transcription-errors",
    "garden colon the drip kid needs to reach the balcony parts. and remind me to cool mom on sunday about her birthday party",
    [["drip"], ["mom"]]),
  seg("four-items",
    "Buy more drippers for the beds. The accountant said the deadline is in November. Book the ferry for the Portugal trip. And my new phone number is 079 555 12 34, remember that.",
    [["drippers"], ["accountant"], ["ferry"], ["phone"]]),
  seg("one-subject-two-questions",
    "find out if Velostation Nord repairs e-bikes and what a service costs",
    [["e-bike", "cost"]]),
  seg("short-single-no-call",
    "Remind me to water the tomatoes tonight",
    [["tomatoes"]]),
  // Issue #19: a follow-up that only makes sense with the part before it stays in one item.
  seg("research-then-message-about-it",
    "Research infos about when the Umwelt Arena Spreitenbach was created and message me about it tomorrow moning.",
    [["umwelt", "message"]]),
  seg("background-then-request",
    "There was a proposal to build a subway in zurich but it was declined by popular vote. Research why and what the public said were the reasons.",
    [["subway", "research"]]),
  seg("find-then-book-it",
    "Look up which pizzeria near Hardbrücke has the best reviews. If it's open on Sunday, reserve a table for four there.",
    [["pizzeria", "reserve"]]),
  seg("context-then-question",
    "The heat pump makes a loud humming noise at night since the service last week. Is that normal or should I call them back?",
    [["heat pump", "normal"]]),
  seg("dependent-plus-unrelated",
    "Research when the Umwelt Arena Spreitenbach was created and message me about it tomorrow morning. Also remind me to buy milk tonight.",
    [["umwelt", "message"], ["milk"]]),
  // Stage of episode/capture-no-cross-talk: the cost question stays with the e-bike item (v7 split it off).
  seg("no-cross-talk-memo",
    "garden: the drip kit also needs to reach the two balcony pots. remind me Friday to file the tax extension, and find out if Velostation Nord repairs e-bikes and what a service costs",
    [["balcony"], ["tax"], ["e-bike", "cost"]]),
  // Observer trace: the aside "Just to test the system." was filed as a conversation of its own.
  seg("remind-with-aside",
    "Remind me in 10min. Just to test the system.",
    [["remind"]]),
];
