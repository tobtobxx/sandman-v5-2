// Librarian (§7.6): does memory answer, narrow, or not help? Staleness is computed in code.

import { all, Case, has, note } from "../lib.ts";
import { createCard, getCard } from "../../src/work/board.ts";
import { runLibrarian } from "../../src/work/preflight.ts";

function lib(name: string, setup: () => void, title: string, goal: string, done_when: string[], want: string, extra?: (c: any) => [boolean, string][]): Case {
  return {
    id: `librarian/${name}`,
    run: async () => {
      setup();
      const card = createCard({ title, goal, done_when });
      const verdict = await runLibrarian(card);
      return { verdict, card: getCard(card.id) };
    },
    check: (o) => all([want.split("|").includes(o.verdict), `verdict ${o.verdict}, want ${want}`], ...(extra?.(o.card) ?? [])),
  };
}

const velo = (priceAge: number) => () => {
  note("Velostation Nord", [
    { text: "Velostation Nord at the main station repairs e-bikes (Bosch, Shimano Steps, Brose).", days_ago: 5, volatility: "slow" },
    { text: "An e-bike service at Velostation Nord costs CHF 149.", days_ago: priceAge, volatility: "volatile" },
  ]);
  note("Zoo Zürich", [{ text: "Zoo Zürich is open 9:00–17:00 in winter.", days_ago: 20, volatility: "slow" }]);
};

export const cases: Case[] = [
  lib("answered-fresh", velo(3), "E-bike service at Velostation Nord", "Find out whether Velostation Nord repairs e-bikes and what an e-bike service costs.",
    ["States whether they repair e-bikes", "Names the price of an e-bike service"], "answered",
    (c) => [[c.state === "verifying" && c.result_source === "memory", `state ${c.state}`], [has(c.result?.summary, "149"), `summary ${c.result?.summary}`]]),
  lib("narrow-stale-price", velo(14), "E-bike service at Velostation Nord", "Find out whether Velostation Nord repairs e-bikes and what an e-bike service costs.",
    ["States whether they repair e-bikes", "Names the price of an e-bike service"], "narrow",
    (c) => [[/price|cost|149/i.test(c.goal), `narrowed goal: ${c.goal}`], [!/whether .* repairs e-bikes/i.test(c.goal), `narrowed goal still asks everything: ${c.goal}`]]),
  lib("partial-knowledge", () => note("Velostation Nord", [{ text: "Velostation Nord at the main station repairs e-bikes.", days_ago: 5, volatility: "slow" }]),
    "E-bike service price", "Find what an e-bike service at Velostation Nord costs and how long it takes.", ["Names the price", "Names the duration"], "narrow|proceed"),
  lib("unrelated", velo(3), "Heat pump noise", "Find how loud a heat pump may be at night at the neighbour's property line.", ["Names the limit in dB(A)"], "proceed"),
  lib("negative-note", () => note("Rainmaster drip kit", [{ text: "Searched for the Rainmaster drip kit on 20 Sep 2026 and found no shop or manufacturer page.", days_ago: 9, volatility: "slow" }], "negative"),
    "Rainmaster kit price", "Find the price of the Rainmaster drip kit.", ["Names the price, or states that it is not available"], "answered"),
];
