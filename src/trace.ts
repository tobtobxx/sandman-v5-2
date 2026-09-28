// Sessions and tool calls (DESIGN §14.1). LLM calls are logged by the gateway.

import { db, nowIso } from "./db.ts";
import { newId } from "./ids.ts";

export function startSession(type: string, refs: { card_id?: string; topic_id?: string; desk_turn_id?: string } = {}) {
  const id = newId("ses");
  db().insert("sessions", { id, type, ...refs, started_at: nowIso() });
  return id;
}

export function endSession(id: string, outcome: string, steps?: number) {
  db().update("sessions", id, { outcome, ended_at: nowIso(), ...(steps !== undefined ? { steps } : {}) });
}

export function lastLlmCallId(session_id: string): string | null {
  return db().get(`SELECT id FROM llm_calls WHERE session_id=? ORDER BY at DESC, rowid DESC LIMIT 1`, session_id)?.id ?? null;
}
