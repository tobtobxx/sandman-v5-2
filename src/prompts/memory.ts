// Memory prompts: consolidator (DESIGN §7.5).

import { bool, obj, oneOf, str } from "../llm/schema.ts";
import { lines, P } from "./work.ts";

export function matchSubject(c: { subject: string; claim: string; notes: { id: string; title: string; one_liner: string }[] }): P {
  return {
    version: "match_subject/v3",
    maxTokens: 120,
    schema: obj({ analysis: str(200), note_id: oneOf([...c.notes.map((n) => n.id), "none"]) }),
    prompt: `A new fact needs a place in memory. Find the note about the same thing as the fact.
The note does not need to contain the fact already; it only needs to be about the same thing.

Fact about "${c.subject}": ${c.claim}

Notes:
${lines(c.notes.map((n) => `${n.id}: ${n.title}${n.one_liner ? ` — ${n.one_liner}` : ""}`))}
- none: no note is about this thing

A different thing of the same kind is none (another product, another shop, another person).

Examples:
- "Gardena drip starter kit" and note "Gardena Micro-Drip starter set" → the note (another name for the same product)
- "Hozelock Easy Drip kit" and note "Gardena Micro-Drip starter set" → none (a different product of the same kind)
- "Gardena extension set" and note "Gardena Micro-Drip starter set" → none (a different product from the same brand)

Reply with analysis (one sentence), then note_id.`,
  };
}

export function relevanceRubric(c: { subject: string; claim: string; source: string; card_title: string }): P {
  return {
    version: "relevance_rubric/v1",
    maxTokens: 150,
    schema: obj({ analysis: str(200), costly: bool(), reusable: bool(), task_mechanics: bool(), trivial: bool() }),
    prompt: `A work session produced this candidate fact:
Subject: ${c.subject}
Fact: "${c.claim}"
Source: ${c.source}
From the task: "${c.card_title}"

Reply with analysis (one sentence), then true or false for each:
costly: Would finding this again take real effort (research or asking the owner)?
reusable: Could a DIFFERENT future task plausibly need this fact?
task_mechanics: Is this only about how this task was carried out (tools used, steps taken)?
trivial: Is this common knowledge that any assistant already knows?`,
  };
}

export function consolidateFact(c: { note_title: string; claim: string; claims: { id: string; text: string; date: string }[] }): P {
  return {
    version: "consolidate_fact/v1",
    maxTokens: 150,
    schema: obj({
      analysis: str(200),
      decision: oneOf(["new", "duplicate", "update", "contradicts", "discard"]),
      target_claim_id: oneOf([...c.claims.map((x) => x.id), "none"]),
    }),
    prompt: `Memory has a note about "${c.note_title}". A new fact arrived. Decide how it relates to what the note says.

Decisions:
- new: the note doesn't say this yet
- duplicate: a claim already says the same thing
- update: a claim says an older value of the same thing (e.g. an old price); the new fact replaces it
- contradicts: a claim says something different about the same thing, and it is not simply older
- discard: the fact is empty, vague or not about ${c.note_title}

Claims in the note:
${lines(c.claims.map((x) => `${x.id} (${x.date}): ${x.text}`))}

New fact: ${c.claim}

Reply with analysis (one sentence), then decision, then target_claim_id: the claim it duplicates, updates or contradicts, or none.`,
  };
}
