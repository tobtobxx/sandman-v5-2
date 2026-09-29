// Memory search (§7.6): the ranking the librarian, workers, desk and the Memory page share.
// Queries share no words with the note they should find, so only search by meaning finds them;
// unrelated notes must stay out. No chat-model calls, only embeddings.

import { all, Case, note } from "../lib.ts";
import { addOwnerFact } from "../../src/memory/facts.ts";
import { findNotes } from "../../src/memory/retriever.ts";

function memory() {
  note("Zoo Zürich", [{ text: "Zoo Zürich is open daily from 9:00 to 18:00 in summer and to 17:00 in winter.", days_ago: 3, volatility: "slow" }]);
  note("Heat pump subsidy Zurich", [{ text: "Canton Zurich pays up to CHF 6000 when an oil heating is replaced by a heat pump.", days_ago: 20, volatility: "slow" }]);
  note("Velostation Nord", [{ text: "An e-bike service at Velostation Nord costs CHF 149.", days_ago: 2, volatility: "volatile" }]);
  note("Tax return 2025", [{ text: "The deadline for the 2025 tax return can be extended online until end of November for a fee.", days_ago: 10, volatility: "slow" }]);
  note("Stadtbibliothek", [{ text: "Die Stadtbibliothek hat samstags von 10 bis 16 Uhr geöffnet.", days_ago: 5, volatility: "slow" }]);
  addOwnerFact({ subject: "Alex's bicycle", claim: "Alex rides a Gazelle city bike with 28 inch tyres.", volatility: "evergreen" });
}

function search(name: string, query: string, want: string | null, k = 3): Case {
  return {
    id: `search/${name}`,
    run: async () => {
      memory();
      return (await findNotes(query, [], k)).map((n) => n.title);
    },
    check: (titles: string[]) => want === null
      ? { pass: !titles.length, detail: `found ${titles.join(", ")}` }
      : all([titles[0] === want, `first: ${titles[0] ?? "nothing"}, want ${want} (all: ${titles.join(", ")})`], [titles.length <= 2, `${titles.length} results: ${titles.join(", ")}`]),
  };
}

export const cases: Case[] = [
  search("paraphrase", "when do the animals park gates close", "Zoo Zürich"),
  search("cross-language", "Förderbeitrag für Wärmepumpen", "Heat pump subsidy Zurich"),
  search("pending-fact", "what wheel size does my bike have", "Alex's bicycle"),
  search("repair-cost", "how much is servicing my electric bike", "Velostation Nord"),
  search("german-note-english-query", "library opening hours on weekends", "Stadtbibliothek"),
  search("words-still-work", "tax return deadline", "Tax return 2025"),
  search("unrelated", "a good pizza dough recipe", null),
];
