// Conversation-layer prompts: capture, routing, front desk, answers, topics.

import { arr, nstr, obj, oneOf, str } from "../llm/schema.ts";
import { lines, P, ROLE_LINES } from "./work.ts";

export function segmentCapture(c: { transcript: string }): P {
  return {
    version: "segment_capture/v4",
    maxTokens: 500,
    schema: obj({ analysis: str(300), items: arr(obj({ quote: str(1000) }), 8, 1) }),
    prompt: `Split the owner's voice memo or quick note into items: each is one thing the owner wants done, wants remembered,
or asks. Quote each item's words EXACTLY; leave out filler ("uh", "oh and"). Never put two unrelated subjects in
one item. The text may contain transcription errors.

Split only where each part is still clear on its own. Keep in one item:
- background followed by a request about it ("There was X. Research why.")
- a follow-up step on another part's result ("find out X and message me about it", "if it's open, book it")
- a part that points back with "it", "that", "there", "why" or "the reasons"
- several questions about one subject ("find out if the bike shop repairs e-bikes and what a service costs")

Reply with analysis (one sentence), then items.

Text:
"${c.transcript}"`,
  };
}

export function routeItem(c: { quote: string; candidates: { slug: string; title: string; aliases?: string[]; summary: string; last_active: string }[]; today: string; allowChat?: boolean }): P {
  const opts = [...c.candidates.map((t) => t.slug), "new", ...(c.allowChat ? ["chat"] : [])];
  // the title only when the slug doesn't already say it
  const title = (t: { slug: string; title: string }) => t.title.toLowerCase().replace(/[^a-z0-9]+/g, "") === t.slug.replace(/-/g, "") ? "" : ` ${t.title}`;
  return {
    version: "route_item/v5",
    maxTokens: 120,
    schema: obj({ analysis: str(300), choice: oneOf(opts), confidence: oneOf(["high", "low"]) }),
    prompt: `Which topic does a message belong to? Choose a topic id, or new if no topic is about the same subject${c.allowChat ? `,
or chat if it is not about one subject (a greeting, small talk, or a question about everything: how things stand, a briefing, an overview)` : ""}.
If the owner names a topic (e.g. "Garden: …"), choose the topic that name refers to.
Reply with analysis (one sentence), then choice, then confidence: high if clearly right, low if unsure.

Today is ${c.today}. Topics (id: title (last active). summary):
${lines(c.candidates.map((t) => `${t.slug}:${title(t)}${t.aliases?.length ? ` (also: ${t.aliases.join(", ")})` : ""} (${t.last_active}).${t.summary ? " " + t.summary.split("\n")[0].slice(0, 160) : ""}`))}

Message (voice memo or quick note, may contain transcription errors):
"${c.quote}"`,
  };
}

export function topicTitle(c: { quote: string }): P {
  return {
    version: "topic_title/v2",
    maxTokens: 40,
    schema: obj({ title: str(60) }),
    prompt: `Name a new topic for a note in at most 5 words: the subject, not the action ("E-bike repair", not "Ask about e-bike repair").

Note: "${c.quote}"`,
  };
}

export function matchAnswer(c: { question: string; options: string[]; answer: string }): P {
  return {
    version: "match_answer/v2",
    maxTokens: 100,
    schema: obj({ analysis: str(200), choice: oneOf([...c.options, "free_text"]) }),
    prompt: `Which option does the owner's answer mean? free_text if none (it is kept as written).
Reply with analysis (one sentence), then choice.

Question: ${c.question}
Options:
${lines(c.options)}

Answer: "${c.answer}"`,
  };
}

export function topicSame(c: { a: string; b: string }): P {
  return {
    version: "topic_same/v2",
    maxTokens: 100,
    schema: obj({ analysis: str(200), same: oneOf(["yes", "no"]) }),
    prompt: `Are two topics about the same subject, so they should be one? Reply with analysis (one sentence), then same: yes or no.

Topic A: ${c.a}
Topic B: ${c.b}`,
  };
}

// ---------------------------------------------------------------- front desk
export interface DeskCtx {
  owner: string;
  mode: "capture" | "conversation";
  topic_title: string;
  topic_summary: string;
  profile: string;
  history: string[];
  cards: { id: string; line: string }[];
  questions: { id: string; line: string }[];
  memory: string;
  input: string;
  transcript?: string;
  receipts: string[];
  now: string;
  /** conversation topics only: where every topic stands, built in code */
  overview?: string;
}

function deskContext(c: DeskCtx) {
  const s: string[] = [];
  s.push(`Topic: ${c.topic_title}${c.topic_summary ? `\n${c.topic_summary}` : ""}`);
  if (c.profile) s.push(`About ${c.owner}:\n${c.profile}`);
  if (c.overview) s.push(`Where things stand:\n${c.overview}`);
  if (c.memory) s.push(`Known from memory:\n${c.memory}`);
  if (c.history.length) s.push(`Recent messages:\n${c.history.join("\n")}`);
  // empty lists are left out: the actions that need them are not offered then
  if (c.cards.length) s.push(`${c.overview ? "Open cards (all topics)" : "Cards in this topic"}:\n${lines(c.cards.map((x) => `${x.id}: ${x.line}`))}`);
  if (c.questions.length) s.push(`Open questions:\n${lines(c.questions.map((x) => `${x.id}: ${x.line}`))}`);
  s.push(`Now: ${c.now}`);
  return s.join("\n\n");
}

function deskInput(c: DeskCtx) {
  // The full memo is deliberately NOT shown (deviation from DESIGN §6.3): with it, the desk acted on
  // other items' parts (see docs/BENCH.md). Each item is handled on its own.
  if (c.mode === "capture") return `${c.owner}'s voice memo or quick note (may contain transcription errors):\n"${c.input}"`;
  return `${c.owner}'s message:\n"${c.input}"`;
}

export const INTENT_LINES: Record<string, string> = {
  new_work: "new_work: the owner wants something researched, written or compared",
  reminder: "reminder: the owner wants to be reminded of something at a time",
  answer_question: "answer_question: the owner answers one of the open questions (gives a choice or decision)",
  add_to_card: "add_to_card: the owner adds a requirement or detail to one of the cards",
  cancel_card: "cancel_card: the owner wants to stop one of the cards",
  reply_only: "reply_only: a question you can answer from what you see here (including how work is going), or a request Sandman can't do (buying, sending, calling)",
  nothing: "nothing: no action and no reply needed (e.g. \"thanks\", or a remark to keep in mind)",
  done: "done: everything the owner said has been handled",
};

export function deskIntent(c: DeskCtx & { intents: string[] }): P {
  return {
    version: "desk_intent/v6",
    maxTokens: 120,
    schema: obj({ analysis: str(300), intent: oneOf(c.intents) }),
    prompt: `You are the front desk. ${c.owner} is the owner. Decide the NEXT action for what ${c.owner} said.

Actions:
${lines(c.intents.map((i) => INTENT_LINES[i]))}

${deskContext(c)}

${deskInput(c)}${c.receipts.length ? `\n\nDone so far for this:\n${lines(c.receipts)}` : ""}

Reply with analysis (one sentence), then intent.`,
  };
}

/** Gate for later passes (P2): only after "something is left" are actions offered again. */
export function deskMore(c: DeskCtx): P {
  return {
    // v1 asked "is a request still NOT handled? yes/no": the negation flipped the answer, and the model
    // often wrote "nothing is left" in its analysis and then left: yes (#24). Named options avoid that.
    version: "desk_more/v3",
    maxTokens: 100,
    schema: obj({ analysis: str(300), left: oneOf(["nothing", "another_request"]) }),
    prompt: `You are the front desk. Check whether everything the owner said has been handled: does the message contain
another, clearly separate request that the actions done did not handle? Details of a handled request don't
count. When an action answered a question, the words of that answer count as handled too (e.g. "yes, book it"
answering "Should I book it?").

${deskInput(c)}

Done so far:
${lines(c.receipts)}

Reply with analysis (one sentence), then left: nothing (all handled) or another_request.`,
  };
}

export function deskArgsNewWork(c: DeskCtx): P {
  return {
    version: "desk_args_new_work/v4",
    maxTokens: 350,
    schema: obj({ analysis: str(300), done_when: arr(str(200), 3), goal: str(600), role: oneOf(["research", "write"]), title: str(80) }),
    prompt: `You are the front desk. Create a work card for only the part of the owner's message that asks for research or
writing (reminders and additions to other cards are handled separately). Reply with analysis (one sentence), then:
- done_when: 1-3 checks of what the result contains (not how it was made). For research allow "or states that
  it is not available", e.g. "Names the repair price, or states that it is not available"
- goal: what to find out or write, with every detail the owner gave (names, places, criteria)
- role: ${Object.values(ROLE_LINES).join(" or ")}
- title: short

${deskContext(c)}

${deskInput(c)}`,
  };
}

export function deskArgsReminder(c: DeskCtx): P {
  return {
    version: "desk_args_reminder/v4",
    maxTokens: 100,
    schema: obj({ text: str(200), when_text: str(80) }),
    prompt: `You are the front desk. Set a reminder; handle only the reminder part. Reply with:
- text: a short instruction (e.g. "File the tax extension")
- when_text: when, in the owner's words (e.g. "Friday", "tomorrow at 3pm", "in 2 hours")

${deskInput(c)}${c.receipts.length ? `\n\nDone so far for this:\n${lines(c.receipts)}` : ""}`,
  };
}

export function deskArgsAnswer(c: DeskCtx): P {
  return {
    version: "desk_args_answer/v2",
    maxTokens: 120,
    schema: obj({ question_id: oneOf(c.questions.map((q) => q.id)), response: str(300) }),
    prompt: `You are the front desk. The owner answers an open question. Reply with question_id, then response: the answer in their words.

Open questions:
${lines(c.questions.map((x) => `${x.id}: ${x.line}`))}

${deskInput(c)}`,
  };
}

export function deskArgsAdd(c: DeskCtx): P {
  return {
    version: "desk_args_add/v4",
    maxTokens: 150,
    schema: obj({ card_id: oneOf(c.cards.map((x) => x.id)), note: str(400) }),
    prompt: `You are the front desk. The owner adds something to a card. Reply with card_id, then note: only the addition,
as an instruction for whoever works on the card.

Cards:
${lines(c.cards.map((x) => `${x.id}: ${x.line}`))}

${deskInput(c)}`,
  };
}

export function deskArgsCancel(c: DeskCtx): P {
  return {
    version: "desk_args_cancel/v2",
    maxTokens: 60,
    schema: obj({ card_id: oneOf(c.cards.map((x) => x.id)) }),
    prompt: `You are the front desk. Reply with card_id: the card the owner wants to stop.

Cards:
${lines(c.cards.map((x) => `${x.id}: ${x.line}`))}

${deskInput(c)}`,
  };
}

export function deskReply(c: DeskCtx): P {
  return {
    version: "desk_reply/v3",
    maxTokens: 500,
    schema: {},
    prompt: `You are the front desk, ${c.owner}'s assistant. Reply to ${c.owner} in 1-3 short sentences. If ${c.owner} asks for an
overview or a list, use one short line per topic instead. If ${c.owner} asks for a length (e.g. one sentence), keep
to it. Plain text, no markdown. Only say you did something if it is listed under "Done". If you don't know
something, say so.${c.mode === "capture" ? "\nKeep it short and easy to listen to." : ""}

${deskContext(c)}

${deskInput(c)}

Done:
${lines(c.receipts, "(nothing)")}

Reply with the message text only.`,
  };
}

export function resolveWhen(c: { when_text: string; now: string; days: string[] }): P {
  return {
    version: "resolve_when/v2",
    maxTokens: 120,
    schema: obj({ analysis: str(200), date: oneOf(c.days.map((d) => d.slice(0, 10))), time: nstr(5) }),
    prompt: `Which date and time does the owner mean? Reply with analysis (one sentence), then date (from the calendar), then
time as HH:MM (24h), or null if no time was said.

Calendar:
${lines(c.days)}

Now: ${c.now}
The owner said: "${c.when_text}"`,
  };
}

export function summarizeTopic(c: { title: string; old: string; messages: string[] }): P {
  return {
    version: "summarize_topic/v2",
    maxTokens: 250,
    schema: {},
    prompt: `Summarize where a topic stands in at most 120 words of plain sentences: what the owner wants, what was decided,
what is being worked on and what is open. Reply with the summary only.

Topic: ${c.title}
${c.old ? `\nPrevious summary:\n${c.old}\n` : ""}
Messages:
${c.messages.join("\n")}`,
  };
}

export function extractOwnerFacts(c: { owner: string; messages: string[] }): P {
  return {
    version: "extract_owner_facts/v2",
    maxTokens: 300,
    schema: obj({
      facts: arr(obj({ claim: str(300), subject: str(80), volatility: oneOf(["evergreen", "slow", "volatile"]) }), 6),
    }),
    prompt: `List what the owner, ${c.owner}, stated about their own preferences, decisions, constraints or situation (not
requests or questions; most messages have none). Reply with facts (maybe empty):
- claim: one sentence, e.g. "${c.owner} prefers low-maintenance options."
- subject: e.g. "${c.owner}" or "Raised beds"
- volatility: evergreen (won't change), slow (months), volatile (weeks)

Messages:
${c.messages.join("\n")}`,
  };
}
