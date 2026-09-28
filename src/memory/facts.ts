// Candidate facts (DESIGN §7.4). Workers propose; the consolidator decides later.

import { db, nowIso, Row } from "../db.ts";
import { newId } from "../ids.ts";
import type { Card } from "../work/board.ts";

export function enqueueFacts(card: Card) {
  const facts: Row[] = card.result?.facts ?? [];
  for (const f of facts) {
    if (!f?.claim || !f?.subject) continue;
    db().insert("facts", {
      id: newId("fct"), card_id: card.id, topic_id: card.origin_topic_id, subject: f.subject, text: f.claim,
      source: { type: /^https?:/.test(f.source ?? "") ? "url" : "card", ref: f.source ?? card.id, card_id: card.id },
      volatility: PRICE.test(f.claim) ? "volatile" : f.volatility ?? "slow", status: "pending", created_at: nowIso(),
    });
  }
}

// P12: what code can see, code records. A claim with a money amount is a price, and prices are volatile.
export const PRICE = /(\b(CHF|EUR|USD|GBP|Fr\.)\s?\d|[€$£]\s?\d|\d\s?(CHF|EUR|francs|euros?)\b)/i;

export function addNegativeFact(card: Card, reason: string) {
  db().insert("facts", {
    id: newId("fct"), card_id: card.id, topic_id: card.origin_topic_id, subject: card.title,
    text: `Searched for "${card.goal.slice(0, 200)}" on ${nowIso().slice(0, 10)} and found nothing: ${reason.slice(0, 200)}`,
    source: { type: "card", ref: card.id, negative: true }, volatility: "slow", status: "pending", created_at: nowIso(),
  });
}

export function addOwnerFact(f: { subject: string; claim: string; volatility: string; topic_id?: string | null; message_id?: string | null }) {
  db().insert("facts", {
    id: newId("fct"), message_id: f.message_id ?? null, topic_id: f.topic_id ?? null, subject: f.subject, text: f.claim,
    source: { type: "owner", ref: f.message_id ?? "owner" }, volatility: f.volatility, status: "pending", created_at: nowIso(),
  });
}
