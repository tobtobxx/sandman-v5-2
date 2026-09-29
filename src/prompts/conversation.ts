// Conversation-layer prompts: capture, routing, front desk, answers, topics.

import { arr, nstr, obj, oneOf, str } from "../llm/schema.ts";
import { lines, P, ROLE_LINES } from "./work.ts";

export function segmentCapture(c: { transcript: string }): P {
  return {
    version: "segment_capture/v3",
    maxTokens: 500,
    schema: obj({ analysis: str(300), items: arr(obj({ quote: str(1000) }), 8, 1) }),
    prompt: `The owner recorded a voice memo or wrote a quick note. It may contain several unrelated requests or
remarks, and may contain transcription errors.

Split it into separate items. An item is one subject: one thing the owner wants done, wants
remembered, or asks, together with everything that belongs to it.
For each item, copy its words EXACTLY from the text (quote). Don't rephrase and don't combine two
unrelated subjects into one item. Leave out filler ("uh", "oh and").

Keep parts together when one needs the other to make sense. Split only where each part would still
be clear on its own. Keep in the same item:
- background followed by a request about it ("There was X. Research why.")
- a follow-up step on the result of another ("find out X and message me about it", "if it's open, book it")
- a part that points back with "it", "that", "there", "why" or "the reasons"

Examples:
"Remind me to call the plumber tomorrow and also what was the name of that tile shop"
→ items: [{quote: "Remind me to call the plumber tomorrow"}, {quote: "what was the name of that tile shop"}]
"find out if the bike shop repairs e-bikes and what a service costs"
→ items: [{quote: "find out if the bike shop repairs e-bikes and what a service costs"}] (one subject, one item)
"Look up when the museum opened and send me a summary of it on Monday"
→ items: [{quote: "Look up when the museum opened and send me a summary of it on Monday"}] (the summary is about the research)
"The library changed its opening hours. Find out the new ones."
→ items: [{quote: "The library changed its opening hours. Find out the new ones."}] (background and request)

Text:
"${c.transcript}"

Reply with analysis (one sentence), then items.`,
  };
}

export function routeItem(c: { quote: string; candidates: { slug: string; title: string; summary: string; last_active: string }[]; today: string; allowChat?: boolean }): P {
  const opts = [...c.candidates.map((t) => t.slug), "new", ...(c.allowChat ? ["chat"] : [])];
  return {
    version: "route_item/v3",
    maxTokens: 120,
    schema: obj({ analysis: str(300), choice: oneOf(opts), confidence: oneOf(["high", "low"]) }),
    prompt: `Decide which topic this message belongs to.

Today is ${c.today}. Topics (last active date in parentheses):
${lines(c.candidates.map((t) => `${t.slug}: ${t.title} (${t.last_active}).${t.summary ? " " + t.summary.split("\n")[0].slice(0, 160) : ""}`))}
- new: none of these topics fits; this starts a new subject${c.allowChat ? `
- chat: not about one subject: a greeting, small talk, or a question about everything (how things stand, a briefing, an overview)` : ""}

If the owner names a topic explicitly (e.g. "Garden: …"), choose the topic that name refers to.
Choose new only if no topic is about the same subject.

Message (from a voice memo or quick note, may contain transcription errors):
"${c.quote}"

Reply with analysis (one sentence), then choice, then confidence: high if clearly right, low if you're unsure.`,
  };
}

export function topicTitle(c: { quote: string }): P {
  return {
    version: "topic_title/v1",
    maxTokens: 40,
    schema: obj({ title: str(60) }),
    prompt: `Name a new topic for this note. Use at most 5 words, naming the subject, not the action
(e.g. "E-bike repair", not "Ask about e-bike repair").

Note: "${c.quote}"

Reply with title.`,
  };
}

export function matchAnswer(c: { question: string; options: string[]; answer: string }): P {
  return {
    version: "match_answer/v1",
    maxTokens: 100,
    schema: obj({ analysis: str(200), choice: oneOf([...c.options, "free_text"]) }),
    prompt: `The owner answered a question. Decide which option the answer means.

Question: ${c.question}
Options:
${lines(c.options)}
- free_text: the answer means none of the options; it will be kept as written

Answer: "${c.answer}"

Reply with analysis (one sentence), then choice.`,
  };
}

export function topicSame(c: { a: string; b: string }): P {
  return {
    version: "topic_same/v1",
    maxTokens: 100,
    schema: obj({ analysis: str(200), same: oneOf(["yes", "no"]) }),
    prompt: `Are these two topics about the same subject, so they should be one topic?

Topic A: ${c.a}
Topic B: ${c.b}

Reply with analysis (one sentence), then same: yes or no.`,
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
  s.push(`${c.overview ? "Open cards (all topics)" : "Cards in this topic"}:\n${lines(c.cards.map((x) => `${x.id}: ${x.line}`))}`);
  s.push(`Open questions:\n${lines(c.questions.map((x) => `${x.id}: ${x.line}`))}`);
  s.push(`Now: ${c.now}`);
  return s.join("\n\n");
}

function deskInput(c: DeskCtx) {
  // The full memo is deliberately NOT shown (deviation from DESIGN §6.3): with it, the desk acted on
  // other items' parts (see docs/BENCH.md). Each item is handled on its own.
  if (c.mode === "capture") return `${c.owner} said this in a voice memo or quick note (it may contain transcription errors):\n"${c.input}"`;
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
    version: "desk_intent/v5",
    maxTokens: 120,
    schema: obj({ analysis: str(300), intent: oneOf(c.intents) }),
    prompt: `You are Sandman's front desk. ${c.owner} is the owner. Decide the NEXT action for what ${c.owner} said.

Actions:
${lines(c.intents.map((i) => INTENT_LINES[i]))}

${deskContext(c)}

${deskInput(c)}
${c.receipts.length ? `\nDone so far for this:\n${lines(c.receipts)}\n` : ""}
Reply with analysis (one sentence), then intent.`,
  };
}

/** Gate for later passes (P2): only after "something is left" are actions offered again. */
export function deskMore(c: DeskCtx): P {
  return {
    version: "desk_more/v1",
    maxTokens: 100,
    schema: obj({ analysis: str(300), left: oneOf(["yes", "no"]) }),
    prompt: `You are Sandman's front desk. Check whether everything ${c.owner} said has been handled.

${deskInput(c)}

Done so far:
${lines(c.receipts)}

Is a clearly separate request in it still NOT handled? Details of a request that was handled don't count.

Reply with analysis (one sentence), then left: yes or no.`,
  };
}

export function deskArgsNewWork(c: DeskCtx): P {
  return {
    version: "desk_args_new_work/v3",
    maxTokens: 350,
    schema: obj({ analysis: str(300), done_when: arr(str(200), 3), goal: str(600), role: oneOf(["research", "write"]), title: str(80) }),
    prompt: `You are Sandman's front desk. Create a work card for what ${c.owner} asked.
Only for the part that asks for research or writing. Other parts (reminders, additions to other cards)
are handled separately; leave them out of this card.

Roles:
${lines(Object.values(ROLE_LINES))}

- title: a short title
- goal: what to find out or write, with every detail ${c.owner} gave (names, places, criteria)
- done_when: 1-3 checks of what the result contains. Say what the result includes, not how it was made.
  For research, allow "or states that it is not available".
  Example: "Names the repair price, or states that it is not available"

${deskContext(c)}

${deskInput(c)}

Reply with analysis (one sentence), then done_when, goal, role, title.`,
  };
}

export function deskArgsReminder(c: DeskCtx): P {
  return {
    version: "desk_args_reminder/v3",
    maxTokens: 100,
    schema: obj({ text: str(200), when_text: str(80) }),
    prompt: `You are Sandman's front desk. ${c.owner} wants a reminder. Only handle the reminder part.

- text: what to remind ${c.owner} of, as a short instruction (e.g. "File the tax extension")
- when_text: when, in ${c.owner}'s words (e.g. "Friday", "tomorrow at 3pm", "in 2 hours")

${deskInput(c)}
${c.receipts.length ? `\nDone so far for this:\n${lines(c.receipts)}\n` : ""}
Reply with text, then when_text.`,
  };
}

export function deskArgsAnswer(c: DeskCtx): P {
  return {
    version: "desk_args_answer/v1",
    maxTokens: 120,
    schema: obj({ question_id: oneOf(c.questions.map((q) => q.id)), response: str(300) }),
    prompt: `You are Sandman's front desk. ${c.owner} is answering an open question.

Open questions:
${lines(c.questions.map((x) => `${x.id}: ${x.line}`))}

${deskInput(c)}

Reply with question_id, then response: ${c.owner}'s answer, in their words.`,
  };
}

export function deskArgsAdd(c: DeskCtx): P {
  return {
    version: "desk_args_add/v3",
    maxTokens: 150,
    schema: obj({ card_id: oneOf(c.cards.map((x) => x.id)), note: str(400) }),
    prompt: `You are Sandman's front desk. ${c.owner} is adding something to an existing card.

Cards:
${lines(c.cards.map((x) => `${x.id}: ${x.line}`))}

${deskInput(c)}

Reply with card_id, then note: only the addition for this card, as an instruction for whoever works on it.`,
  };
}

export function deskArgsCancel(c: DeskCtx): P {
  return {
    version: "desk_args_cancel/v1",
    maxTokens: 60,
    schema: obj({ card_id: oneOf(c.cards.map((x) => x.id)) }),
    prompt: `You are Sandman's front desk. ${c.owner} wants to stop a card.

Cards:
${lines(c.cards.map((x) => `${x.id}: ${x.line}`))}

${deskInput(c)}

Reply with card_id: the card to stop.`,
  };
}

export function deskReply(c: DeskCtx): P {
  return {
    version: "desk_reply/v2",
    maxTokens: 500,
    schema: {},
    prompt: `You are Sandman, ${c.owner}'s assistant. Reply to ${c.owner} in 1-3 short sentences.
If ${c.owner} asks for an overview or a list, use one short line per topic instead. If ${c.owner} asks for a
length (e.g. one sentence), keep to it. Plain text, no markdown.
Only say you did something if it is listed under "Done". If you don't know something, say so.
${c.mode === "capture" ? "Keep it short and easy to listen to." : ""}

${deskContext(c)}

${deskInput(c)}

Done:
${lines(c.receipts, "(nothing)")}

Reply with the message text only.`,
  };
}

export function resolveWhen(c: { when_text: string; now: string; days: string[] }): P {
  return {
    version: "resolve_when/v1",
    maxTokens: 120,
    schema: obj({ analysis: str(200), date: oneOf(c.days.map((d) => d.slice(0, 10))), time: nstr(5) }),
    prompt: `Find the date and time the owner means.

Now: ${c.now}
Calendar:
${lines(c.days)}

The owner said: "${c.when_text}"

Reply with analysis (one sentence), then date (from the calendar), then time as HH:MM (24h), or null if no time was said.`,
  };
}

export function summarizeTopic(c: { title: string; old: string; messages: string[] }): P {
  return {
    version: "summarize_topic/v1",
    maxTokens: 250,
    schema: {},
    prompt: `Write where things stand in the topic "${c.title}", in at most 120 words. Plain sentences, no headings.
Say what the owner wants, what was decided, what is being worked on and what is open.
${c.old ? `\nPrevious summary:\n${c.old}\n` : ""}
Messages:
${c.messages.join("\n")}

Reply with the summary only.`,
  };
}

export function extractOwnerFacts(c: { owner: string; messages: string[] }): P {
  return {
    version: "extract_owner_facts/v1",
    maxTokens: 300,
    schema: obj({
      facts: arr(obj({ claim: str(300), subject: str(80), volatility: oneOf(["evergreen", "slow", "volatile"]) }), 6),
    }),
    prompt: `Find what ${c.owner} said about their own preferences, decisions, constraints or personal situation.
Only things ${c.owner} stated, not requests or questions. Most messages contain none.

- claim: one sentence, e.g. "${c.owner} prefers low-maintenance options."
- subject: what the fact is about, e.g. "${c.owner}" or "Raised beds"
- volatility: evergreen (won't change), slow (may change over months), volatile (may change within weeks)

Messages from ${c.owner}:
${c.messages.join("\n")}

Reply with facts (empty if there are none).`,
  };
}
