// Router (§6.4): which topic does an item belong to? Code picks candidates, the model the answer.

import { Case, topic } from "../lib.ts";
import { routeItem } from "../../src/conversation/capture.ts";
import { db } from "../../src/db.ts";

function world() {
  topic("Raised bed irrigation", "Comparing drip irrigation kits for the three raised beds in the garden.");
  topic("Taxes 2026", "Tax return 2026: deadlines, accountant, extension.");
  topic("Bike maintenance", "Servicing the city bike and the e-bike; finding a repair shop.");
  topic("Kitchen renovation", "New kitchen: cabinets, tiles, backsplash, contractor quotes.");
  topic("Holiday Portugal", "Two weeks in Portugal in October: Lisbon, Algarve, ferries and hotels.");
  topic("Mom's 70th birthday", "Party and present for mom's 70th birthday in November.");
}

// The world of the capture episodes: only these two topics exist.
function episodeWorld() {
  topic("Raised bed irrigation", "Comparing drip irrigation kits for the three raised beds in the garden.");
  topic("Taxes 2026", "Tax return 2026: deadlines, accountant, extension.");
}

function route(name: string, quote: string, want: string | "new" | "chat", extra?: (o: any) => string | null, setup = world): Case {
  return {
    id: `route/${name}`,
    run: async () => {
      setup();
      const r = await routeItem(quote);
      return { ...r, slug: db().get(`SELECT slug, title FROM topics WHERE id=?`, r.topic_id) };
    },
    check: (o) => {
      const got = o.kind === "conversation" ? "chat" : o.created ? "new" : o.slug.slug;
      if (got !== want) return { pass: false, detail: `routed to ${got} (${o.slug.title}), want ${want}` };
      const e = extra?.(o);
      return e ? { pass: false, detail: e } : true;
    },
  };
}

const titleOk = (o: any) => {
  const t: string = o.slug.title;
  const words = t.split(/\s+/).length;
  if (words > 5) return `new topic title too long: "${t}"`;
  if (/^(find|check|look|ask|research|search|get|call)\b/i.test(t)) return `new topic title is an action: "${t}"`;
  return null;
};

export const cases: Case[] = [
  route("named-topic", "Garden: the kit must also reach the balcony pots", "raised-bed-irrigation"),
  route("named-topic-misheard", "guarding: order twenty more drippers", "raised-bed-irrigation"),
  route("implicit-taxes", "remind me Friday to file the tax extension", "taxes-2026"),
  route("implicit-bike", "find out if the bike shop near the station repairs e-bikes", "bike-maintenance"),
  route("implicit-kitchen", "the tiles for the backsplash should be matte, not glossy", "kitchen-renovation"),
  route("implicit-holiday", "check whether we need to book the ferry to the Algarve islands in advance", "holiday-portugal"),
  route("implicit-mom", "what's a good present for someone turning 70 who loves gardening, it's for mom", "moms-70th-birthday"),
  route("new-subject", "look up how loud a heat pump is at night", "new", titleOk),
  route("new-subject-2", "find a dentist near Oerlikon who takes new patients", "new", titleOk),
  route("chat-hi", "hi", "chat"),
  route("chat-how-are-you", "hey sandman, how's it going?", "chat"),
  route("chat-brief", "brief me in one sentence", "chat"),
  route("chat-overview", "give me an overview of everything that's going on", "chat"),
  route("not-chat-topic-question", "what did the bike shop say about e-bikes again?", "bike-maintenance"),
  route("not-chat-named-overview", "give me an overview of where the kitchen renovation stands", "kitchen-renovation"),
  route("new-not-similar-word", "my ski helmet is broken, find a new one before the season starts", "new", titleOk),
  // Stages of episode/capture-three-items: each item of the memo against the episode's two topics.
  route("episode-garden", "garden: the kit must also reach the balcony pots", "raised-bed-irrigation", undefined, episodeWorld),
  route("episode-tax", "remind me Friday to file the tax extension", "taxes-2026", undefined, episodeWorld),
  route("episode-bike-new", "find out if the bike shop repairs e-bikes", "new", titleOk, episodeWorld),
];
