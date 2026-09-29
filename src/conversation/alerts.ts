// Model reachability (DESIGN §13, §6.8): a `system` message in the Sandman topic when the model can't
// be reached, one more when it is back (one of each per outage), and a shared backoff that the
// background loops (dispatcher, capture retry) wait out.

import { db, j } from "../db.ts";
import { LLMFailure, onModelHealth } from "../llm/gateway.ts";
import { postMessage } from "./messages.ts";
import { systemTopicId } from "./questions.ts";

/** Consecutive unreachable calls before the owner is told (one timeout alone is not an outage). */
const ALERT_AFTER = 2;
const BACKOFF_MIN_MS = 5_000, BACKOFF_MAX_MS = 5 * 60_000;

let failures = 0;
let retryAt = 0;
let alerted: boolean | null = null; // last alert posted was "down"; null: not read from the database yet

let installed = false;
export function installModelAlerts() {
  if (installed) return;
  installed = true;
  onModelHealth((ok, e) => ok ? reachable() : unreachable(e!));
}

/** True while the background loops should not start model work. */
export function modelBackoff(): boolean {
  return Date.now() < retryAt;
}

function isAlerted(): boolean {
  if (alerted === null) {
    const m = db().get(
      `SELECT payload FROM messages WHERE topic_id=? AND kind='system' AND json_extract(payload,'$.alert') IS NOT NULL ORDER BY created_at DESC, rowid DESC LIMIT 1`,
      systemTopicId(),
    );
    alerted = j<{ alert?: string }>(m?.payload, {}).alert === "model_down";
  }
  return alerted;
}

function unreachable(e: LLMFailure) {
  failures++;
  retryAt = Date.now() + Math.min(BACKOFF_MIN_MS * 2 ** (failures - 1), BACKOFF_MAX_MS);
  if (failures < ALERT_AFTER || isAlerted()) return;
  alerted = true;
  postMessage({
    topic_id: systemTopicId(), role: "sandman", kind: "system",
    body: `Can't reach the model (${e.kind}: ${e.message.slice(0, 160)}). Your messages are kept and work waits; both are retried.`,
    payload: { alert: "model_down", error: `${e.kind}: ${e.message}` },
  });
}

function reachable() {
  failures = 0;
  retryAt = 0;
  if (!isAlerted()) return;
  alerted = false;
  postMessage({ topic_id: systemTopicId(), role: "sandman", kind: "system", body: "The model is reachable again. Waiting messages and work continue.", payload: { alert: "model_up" } });
}
