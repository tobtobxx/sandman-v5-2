// Retry and escalation (DESIGN §5.10).

import { config } from "../config.ts";
import { addComment, getCard, transition } from "./board.ts";
import { createQuestion } from "../conversation/questions.ts";
import { addNegativeFact } from "../memory/facts.ts";

export async function failCard(card_id: string, category: string, reason: string) {
  const card = getCard(card_id);
  addComment(card.id, "harness", `Attempt ${card.attempt} ended (${category}): ${reason}`);
  if (card.role === "research" && category === "impossible") addNegativeFact(card, reason);
  const skipRetry = category === "out_of_scope" || category === "unclear";
  if (!skipRetry && card.attempt < config.board.max_attempts) {
    transition(card.id, "ready", `retry:${category}`, "harness", { attempt: card.attempt + 1, lease_owner: null });
    return;
  }
  escalate(card.id, reason);
}

/** Ask the owner what to do with a stuck card. The question text stays short; `why` (default: the full
 *  reason) and the card's latest result go along as details, so the owner can see what went wrong. */
export function escalate(card_id: string, reason: string, why: string[] = [reason]) {
  const card = getCard(card_id);
  const short = reason.split(/(?<=\.)\s/)[0].slice(0, 90);
  const q = createQuestion({
    card_id: card.id,
    topic_id: card.origin_topic_id,
    text: `"${card.title}" is stuck: ${short} What now?`,
    options: ["Retry", "Cancel", "Add guidance"],
    reason: "escalation",
    details: { why: why.filter((w) => w.trim() && w.trim() !== short.trim()), result: card.result?.summary ?? null },
  });
  transition(card.id, "blocked", "escalate", "harness", { blocked_reason: "escalation", lease_owner: null }, { question_id: q.id });
}
