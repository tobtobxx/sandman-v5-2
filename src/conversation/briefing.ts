// Briefings (DESIGN §6.10): a harness-driven dialogue. No model calls unless an answer needs match_answer.

import { db, j, now, nowIso, Row } from "../db.ts";
import { newId } from "../ids.ts";
import { emit } from "../events.ts";
import { answerQuestion, codeMatch, needsYou } from "./questions.ts";
import { fmtWhen, zoned } from "./when.ts";

interface Step {
  kind: "question" | "news" | "reminder" | "end";
  text: string;
  question_id?: string;
  options?: string[];
}

const NUMS = ["one", "two", "three", "four"];

function questionText(q: Row) {
  const opts: string[] = q.options ?? [];
  return `${q.text}${opts.length ? " " + opts.map((o, i) => `${NUMS[i] ?? i + 1}: ${o}.`).join(" ") : ""}`;
}

export function startBriefing(): { id: string; prompt: { text: string; speech: string } } {
  const lastEnd = db().get(`SELECT max(ended_at) t FROM briefings WHERE state='ended'`)?.t ?? "1970";
  const qs = needsYou();
  const steps: Step[] = [];
  steps.push({ kind: "news", text: qs.length ? `${qs.length} ${qs.length === 1 ? "thing needs" : "things need"} you.` : "Nothing needs you right now." });
  for (const q of qs) steps.push({ kind: "question", text: questionText(q), question_id: q.id, options: q.options });
  const done = db().all(`SELECT body, payload FROM messages WHERE kind='card_result' AND created_at > ? ORDER BY created_at`, lastEnd);
  if (done.length) {
    steps.push({ kind: "news", text: `Finished since last time: ${done.map((m) => `${j<Row>(m.payload, {}).title}: ${String(m.body).split(/(?<=\.)\s/)[0]}`).join(" ")}` });
  }
  const z = zoned(now());
  const endOfDay = new Date(now().getTime() + ((23 - z.h) * 60 + (59 - z.min)) * 60e3).toISOString();
  const rem = db().all(`SELECT title, due_at FROM cards WHERE kind='reminder' AND state='ready' AND due_at <= ? ORDER BY due_at`, endOfDay);
  if (rem.length) steps.push({ kind: "reminder", text: `Today: ${rem.map((r) => `${r.title} at ${fmtWhen(new Date(r.due_at)).split(" ").at(-1)}`).join(", ")}.` });
  steps.push({ kind: "end", text: "That's all." });
  const id = newId("brf");
  db().insert("briefings", { id, script: steps, position: 0, state: "active", started_at: nowIso() });
  emit("briefing.started", { ref_id: id, payload: { id, steps: steps.length } });
  return { id, prompt: advance(id, 0, "") };
}

/** Speak steps from position until one needs an answer. */
function advance(id: string, pos: number, prefix: string): { text: string; speech: string } {
  const b = db().get(`SELECT * FROM briefings WHERE id=?`, id)!;
  const steps: Step[] = j(b.script, []);
  const out: string[] = prefix ? [prefix] : [];
  while (pos < steps.length) {
    const s = steps[pos];
    out.push(s.text);
    if (s.kind === "question") break;
    pos++;
  }
  const ended = pos >= steps.length;
  db().update("briefings", id, { position: pos, state: ended ? "ended" : "active", ended_at: ended ? nowIso() : null });
  if (ended) emit("briefing.ended", { ref_id: id });
  const text = out.join(" ");
  return { text, speech: text };
}

export async function replyBriefing(id: string, text: string): Promise<{ text: string; speech: string; ended: boolean; model_calls: number }> {
  const b = db().get(`SELECT * FROM briefings WHERE id=?`, id);
  if (!b || b.state !== "active") return { text: "The briefing has ended.", speech: "The briefing has ended.", ended: true, model_calls: 0 };
  const steps: Step[] = j(b.script, []);
  const s = steps[b.position];
  const t = text.trim().toLowerCase().replace(/[.!?]+$/, "");
  if (/^(stop|end|that's enough|enough)$/.test(t)) {
    db().update("briefings", id, { state: "ended", ended_at: nowIso() });
    emit("briefing.ended", { ref_id: id });
    return { text: "Stopped.", speech: "Stopped.", ended: true, model_calls: 0 };
  }
  if (/^(repeat|again|say again|what)$/.test(t)) return { ...advance(id, b.position, ""), ended: false, model_calls: 0 };
  if (/^(skip|next|later|not now)$/.test(t) || s.kind !== "question") {
    const r = advance(id, b.position + 1, s.kind === "question" ? "Skipped." : "");
    return { ...r, ended: r.text.endsWith("That's all."), model_calls: 0 };
  }
  const q = db().get(`SELECT * FROM questions WHERE id=?`, s.question_id);
  if (!q || q.status !== "open") {
    const r = advance(id, b.position + 1, "");
    return { ...r, ended: false, model_calls: 0 };
  }
  const pre = codeMatch(text, s.options ?? []);
  const out = await answerQuestion(q.id, { text, via: "briefing" });
  if (out.skipped) {
    const r = advance(id, b.position + 1, "Skipped.");
    return { ...r, ended: false, model_calls: 0 };
  }
  const ack = out.option ? `${out.option}.` : "Noted.";
  const r = advance(id, b.position + 1, ack);
  return { ...r, ended: r.text.endsWith("That's all."), model_calls: pre === null && (s.options ?? []).length ? 1 : 0 };
}
