// Dispatcher (DESIGN §5.11): picks runnable cards and runs the right step for each state.
// Also fires due reminders and wires the terminal hooks (results flow back, §5.9).

import { db, now, nowIso } from "../db.ts";
import { config } from "../config.ts";
import { Card, children, getCard, onCardTerminal, parseCard, TERMINAL, transition, treeCallsUsed } from "./board.ts";
import { fanOut, preflight } from "./preflight.ts";
import { runWorker } from "./worker.ts";
import { verifyCard } from "./verifier.ts";
import { escalate } from "./policy.ts";
import { postMessage } from "../conversation/messages.ts";
import { enqueueFacts } from "../memory/facts.ts";
import { LLMFailure } from "../llm/gateway.ts";
import { emit } from "../events.ts";
import { modelBackoff } from "../conversation/alerts.ts";

let hooked = false;
export function installHooks() {
  if (hooked) return;
  hooked = true;
  onCardTerminal((c) => {
    if (c.state === "done") enqueueFacts(c);
    if (c.parent_id) {
      fanOut(c);
      const parent = getCard(c.parent_id);
      if (parent.state === "waiting" && children(parent.id).every((ch) => TERMINAL.includes(ch.state))) {
        transition(parent.id, "ready", "children_done", "harness", { phase: "synthesize", role: "synthesize", attempt: 1 });
      }
    } else if (c.kind === "task" && c.origin_topic_id) {
      const arts = db().all(`SELECT id, name, bytes FROM artifacts WHERE card_id=? AND origin='write'`, c.id);
      const reason = c.state === "failed" ? "failed" : c.state === "cancelled" ? "cancelled" : "";
      postMessage({
        topic_id: c.origin_topic_id, role: "sandman", kind: "card_result",
        body: c.result?.summary ?? (reason ? `${c.title}: ${reason}.` : c.title),
        payload: { card_id: c.id, title: c.title, state: c.state, summary: c.result?.summary ?? null, recommendation: c.result?.recommendation ?? null, artifacts: arts, source: c.result_source },
      });
    }
  });
}

/** Run one step for one card, according to its state. */
export async function stepCard(card_id: string): Promise<string> {
  const card = getCard(card_id);
  if (card.kind === "reminder") return fireReminder(card);
  if (card.kind !== "task") return "skip";
  if (["new", "ready", "verifying"].includes(card.state) && treeCallsUsed(card) >= config.board.max_llm_calls_per_tree) {
    if (card.state !== "blocked") escalate(card.id, `The work used its budget of ${config.board.max_llm_calls_per_tree} model calls.`);
    return "budget";
  }
  try {
    switch (card.state) {
      case "new":
        return await preflight(card.id);
      case "ready":
        return await runWorker(card.id);
      case "verifying":
        return await verifyCard(card.id);
    }
  } catch (e) {
    if (e instanceof LLMFailure && e.kind !== "budget") {
      // model trouble: put the card back and let the retry policy decide next time
      const c = getCard(card.id);
      emit("system.llm_failure", { ref_id: card.id, payload: { error: e.message, state: c.state } });
      if (c.state === "running") transition(c.id, "ready", "llm_failure", "harness", { attempt: c.attempt + 1 });
      return `llm_failure:${e.kind}`;
    }
    throw e;
  }
  return "skip";
}

function fireReminder(card: Card): string {
  if (card.state !== "ready" || !card.due_at || new Date(card.due_at) > now()) return "not_due";
  if (card.origin_topic_id) {
    postMessage({ topic_id: card.origin_topic_id, role: "sandman", kind: "reminder", body: card.title, payload: { card_id: card.id, due_at: card.due_at } });
  }
  transition(card.id, "done", "fired", "scheduler");
  return "fired";
}

const PRIORITY_ORDER = `CASE priority WHEN 'interactive' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END`;

/** `tasks: false`: only due reminders (they need no model). */
export function runnable(rootId?: string, tasks = true): Card[] {
  const rows = db().all(
    `SELECT * FROM cards WHERE ((${tasks ? "" : "0 AND "}kind='task' AND state IN ('new','ready','verifying')) OR (kind='reminder' AND state='ready' AND due_at <= ?))
     ${rootId ? "AND root_id=?" : ""} ORDER BY ${PRIORITY_ORDER}, phase DESC, created_at`,
    nowIso(), ...(rootId ? [rootId] : []),
  );
  return rows.map((r) => parseCard(r)!);
}

/** Crash recovery (§5.11): running cards with an expired lease go back to ready. */
export function reclaimLeases() {
  for (const r of db().all(`SELECT id, attempt FROM cards WHERE state='running' AND (lease_expires_at IS NULL OR lease_expires_at < ?)`, new Date().toISOString())) {
    transition(r.id, "ready", "lease_expired", "harness", { attempt: r.attempt + 1, lease_owner: null });
  }
}

const globalInflight = new Set<string>();

/** Start up to `max` runnable cards concurrently; returns the promises started. */
export function tick(max: number, rootId?: string, inflight = globalInflight, tasks = true): Promise<unknown>[] {
  const started: Promise<unknown>[] = [];
  for (const c of runnable(rootId, tasks)) {
    if (inflight.size >= max) break;
    if (inflight.has(c.id)) continue;
    inflight.add(c.id);
    started.push(stepCard(c.id).catch((e) => console.error("dispatcher:", c.id, e)).finally(() => inflight.delete(c.id)));
  }
  return started;
}

/** Drive one card tree until nothing in it is runnable (benchmark, tests). */
export async function runTree(rootId: string, maxRounds = 60, concurrency = 3): Promise<Card> {
  installHooks();
  const inflight = new Set<string>();
  for (let i = 0; i < maxRounds; i++) {
    const started = tick(concurrency, rootId, inflight);
    if (!started.length) break;
    await Promise.all(started);
  }
  return getCard(rootId);
}

/** Background loop for the server. */
export function startDispatcher(concurrency = config.profiles.small.slots) {
  installHooks();
  reclaimLeases();
  let busy = false;
  setInterval(() => {
    if (busy) return;
    busy = true;
    try {
      // while the model can't be reached, task cards stay ready and wait out the backoff (§13)
      tick(concurrency, undefined, globalInflight, !modelBackoff());
    } finally {
      busy = false;
    }
  }, 1000);
}
