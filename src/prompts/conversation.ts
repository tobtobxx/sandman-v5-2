// Conversation-layer prompts: capture, routing, front desk, answers, topics.

import { arr, nstr, obj, oneOf, str } from "../llm/schema.ts";
import { lines, P, ROLE_LINES } from "./work.ts";

export function segmentCapture(c: { transcript: string }): P {
  return {
    version: "segment_capture/v1",
    maxTokens: 500,
    schema: obj({ analysis: str(300), items: arr(obj({ quote: str(1000) }), 8, 1) }),
    prompt: `The owner recorded a voice memo or wrote a quick note. It may contain several unrelated requests or
remarks, and may contain transcription errors.

Split it into separate items. An item is one thing the owner wants done, wants remembered, or asks.
For each item, copy its words EXACTLY from the text (quote). Don't rephrase and don't combine two
subjects into one item. Leave out filler ("uh", "oh and").

Example:
"Remind me to call the plumber tomorrow and also what was the name of that tile shop"
→ items: [{quote: "Remind me to call the plumber tomorrow"}, {quote: "what was the name of that tile shop"}]

Text:
"${c.transcript}"

Reply with analysis (one sentence), then items.`,
  };
}

export function routeItem(c: { quote: string; candidates: { slug: string; title: string; summary: string }[] }): P {
  return {
    version: "route_item/v1",
    maxTokens: 120,
    schema: obj({ analysis: str(300), choice: oneOf([...c.candidates.map((t) => t.slug), "new"]), confidence: oneOf(["high", "low"]) }),
    prompt: `Decide which topic this item belongs to.

Topics:
${lines(c.candidates.map((t) => `${t.slug}: ${t.title}.${t.summary ? " " + t.summary.split("\n")[0].slice(0, 160) : ""}`))}
- new: none of these topics fits; this starts a new subject

If the owner names a topic explicitly (e.g. "Garden: …"), choose the topic that name refers to.
Choose new only if no topic is about the same subject.

Item (from a voice memo or quick note, may contain transcription errors):
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
}

function deskContext(c: DeskCtx) {
  const s: string[] = [];
  s.push(`Topic: ${c.topic_title}${c.topic_summary ? `\n${c.topic_summary}` : ""}`);
  if (c.profile) s.push(`About ${c.owner}:\n${c.profile}`);
  if (c.memory) s.push(`Known from memory:\n${c.memory}`);
  if (c.history.length) s.push(`Recent messages:\n${c.history.join("\n")}`);
  s.push(`Cards in this topic:\n${lines(c.cards.map((x) => `${x.id}: ${x.line}`))}`);
  s.push(`Open questions:\n${lines(c.questions.map((x) => `${x.id}: ${x.line}`))}`);
  s.push(`Now: ${c.now}`);
  return s.join("\n\n");
}

function deskInput(c: DeskCtx) {
  if (c.mode === "capture") {
    return `${c.owner} said this in a voice memo or quick note (it may contain transcription errors):
"${c.input}"${c.transcript && c.transcript.trim() !== c.input.trim() ? `\n\nFull memo, for context only; other parts are handled separately:\n"${c.transcript}"` : ""}`;
  }
  return `${c.owner}'s message:\n"${c.input}"`;
}

export const INTENT_LINES: Record<string, string> = {
  new_work: "new_work: the owner wants something researched, written or compared",
  reminder: "reminder: the owner wants to be reminded of something at a time",
  answer_question: "answer_question: the owner is answering one of the open questions",
  add_to_card: "add_to_card: the owner adds a requirement or detail to one of the cards",
  reply_only: "reply_only: a question or remark you can answer directly from what you see here",
  nothing: "nothing: no action and no reply needed (e.g. \"thanks\")",
  done: "done: everything the owner said has been handled",
};

export function deskIntent(c: DeskCtx & { intents: string[] }): P {
  return {
    version: "desk_intent/v1",
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

export function deskArgsNewWork(c: DeskCtx): P {
  return {
    version: "desk_args_new_work/v1",
    maxTokens: 350,
    schema: obj({ analysis: str(300), done_when: arr(str(200), 3, 1), goal: str(600), role: oneOf(["research", "write"]), title: str(80) }),
    prompt: `You are Sandman's front desk. Create a work card for what ${c.owner} asked.

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
    version: "desk_args_reminder/v1",
    maxTokens: 100,
    schema: obj({ text: str(200), when_text: str(80) }),
    prompt: `You are Sandman's front desk. ${c.owner} wants a reminder.

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
    version: "desk_args_add/v1",
    maxTokens: 150,
    schema: obj({ card_id: oneOf(c.cards.map((x) => x.id)), note: str(400) }),
    prompt: `You are Sandman's front desk. ${c.owner} is adding something to an existing card.

Cards:
${lines(c.cards.map((x) => `${x.id}: ${x.line}`))}

${deskInput(c)}

Reply with card_id, then note: what to add, as an instruction for whoever works on the card.`,
  };
}

export function deskReply(c: DeskCtx): P {
  return {
    version: "desk_reply/v1",
    maxTokens: 300,
    schema: {},
    prompt: `You are Sandman, ${c.owner}'s assistant. Reply to ${c.owner} in 1-3 short sentences.
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
