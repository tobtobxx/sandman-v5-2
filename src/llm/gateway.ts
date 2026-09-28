// LLM gateway (DESIGN §10, §11). Every model call goes through here.
// - JSON calls run under a JSON schema; output is validated and repaired locally.
// - Every call sets max_tokens. Streaming with an idle timeout; no resend after a timeout.
// - Guards: whitespace watchdog, repetition detection. One retry on parse/repetition errors.
// - Every call is logged to llm_calls, linked to its session, card, topic and step.

import { config, Profile } from "../config.ts";
import { ctx, db, nowIso } from "../db.ts";
import { newId } from "../ids.ts";
import { Schema, validate, wireSchema } from "./schema.ts";

export type Priority = "interactive" | "high" | "normal" | "background";

export interface CallOpts {
  maxTokens: number;
  profile?: string;
  priority?: Priority;
  session_id?: string;
  card_id?: string;
  topic_id?: string;
  step?: number;
  version?: string;
  temperature?: number;
  /** call-specific repair applied before validation (engine quirks, §10.2); must log what it changed */
  repair?: (v: any) => { value: any; note?: string };
}

export class LLMFailure extends Error {
  constructor(public kind: string, msg: string) {
    super(msg);
  }
}

// ---- spend tracking (the benchmark key is budget-limited) ----
export const spend = { usd: 0, calls: 0, byType: {} as Record<string, { calls: number; usd: number; tin: number; tout: number }> };
const budget = Number(Deno.env.get("SANDMAN_BUDGET_USD") ?? "0");

// ---- priority slots per profile (§5.11) ----
const PRI: Record<Priority, number> = { interactive: 0, high: 1, normal: 2, background: 3 };
class Slots {
  busy = 0;
  queue: { pri: number; seq: number; go: () => void }[] = [];
  seq = 0;
  constructor(public n: number) {}
  async acquire(p: Priority) {
    if (this.busy < this.n) {
      this.busy++;
      return;
    }
    await new Promise<void>((go) => {
      this.queue.push({ pri: PRI[p], seq: this.seq++, go });
      this.queue.sort((a, b) => a.pri - b.pri || a.seq - b.seq);
    });
  }
  release() {
    const next = this.queue.shift();
    if (next) next.go();
    else this.busy--;
  }
}
const slots: Record<string, Slots> = {};
const slotsFor = (name: string, p: Profile) => (slots[name] ??= new Slots(p.slots));

// ---- public API ----
export async function llmJson<T = any>(callType: string, prompt: string, schema: Schema, opts: CallOpts): Promise<T> {
  let lastErr: LLMFailure | null = null;
  for (let attempt = 1; attempt <= 2; attempt++) {
    const temperature = attempt === 1 ? opts.temperature : 0;
    try {
      return await callOnce(callType, prompt, schema, { ...opts, temperature }, attempt) as T;
    } catch (e) {
      if (!(e instanceof LLMFailure)) throw e;
      lastErr = e;
      if (!["parse", "repetition", "whitespace", "empty"].includes(e.kind)) break; // no resend after timeout/transport
    }
  }
  throw lastErr!;
}

export async function llmText(callType: string, prompt: string, opts: CallOpts): Promise<string> {
  let lastErr: LLMFailure | null = null;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      return await callOnce(callType, prompt, null, { ...opts, temperature: attempt === 1 ? opts.temperature : 0.1 }, attempt);
    } catch (e) {
      if (!(e instanceof LLMFailure)) throw e;
      lastErr = e;
      if (!["repetition", "whitespace", "empty"].includes(e.kind)) break;
    }
  }
  throw lastErr!;
}

async function callOnce(callType: string, prompt: string, schema: Schema | null, opts: CallOpts, attempt: number): Promise<any> {
  const profileName = opts.profile ?? "small";
  const p = config.profiles[profileName];
  if (budget && spend.usd > budget) throw new LLMFailure("budget", `spend limit ${budget} USD reached`);
  const id = newId("cal");
  const started = Date.now();
  const row: Record<string, any> = {
    id, call_type: callType, prompt_version: opts.version ?? "v1", model_profile: profileName, model: p.model,
    session_id: opts.session_id, card_id: opts.card_id, topic_id: opts.topic_id, step: opts.step, attempt,
    input: prompt, schema: schema ? JSON.stringify(schema) : null, at: nowIso(),
  };
  const tags = ctx().tags;
  if (tags) row.eval_label = JSON.stringify({ tags });
  const s = slotsFor(profileName, p);
  await s.acquire(opts.priority ?? "normal");
  let raw = "";
  try {
    const res = await stream(p, prompt, schema, opts);
    raw = res.text;
    Object.assign(row, { provider: res.provider, tokens_in: res.tin, tokens_out: res.tout, cost: res.cost });
    spend.usd += res.cost;
    spend.calls++;
    const bt = (spend.byType[callType] ??= { calls: 0, usd: 0, tin: 0, tout: 0 });
    bt.calls++, bt.usd += res.cost, bt.tin += res.tin, bt.tout += res.tout;
    if (!raw.trim()) throw new LLMFailure("empty", "empty output");
    if (isRepetitive(raw)) throw new LLMFailure("repetition", "repetitive output");
    if (!schema) {
      row.ok = 1;
      return raw.trim();
    }
    let parsed: any;
    try {
      parsed = JSON.parse(extractJson(raw));
    } catch {
      throw new LLMFailure("parse", "invalid JSON");
    }
    const pre: string[] = [];
    if (opts.repair) {
      const r = opts.repair(parsed);
      parsed = r.value;
      if (r.note) pre.push(r.note);
    }
    const v = validate(schema, parsed);
    v.repairs.unshift(...pre);
    if (v.error) throw new LLMFailure("parse", v.error);
    row.parsed = JSON.stringify(v.value);
    if (v.repairs.length) row.repaired = JSON.stringify(v.repairs);
    row.ok = 1;
    return v.value;
  } catch (e) {
    row.ok = 0;
    row.error = e instanceof LLMFailure ? `${e.kind}: ${e.message}` : `transport: ${(e as Error).message}`;
    if (e instanceof LLMFailure) throw e;
    throw new LLMFailure("transport", (e as Error).message);
  } finally {
    s.release();
    row.raw_output = raw;
    row.ms = Date.now() - started;
    try {
      db().insert("llm_calls", row);
      if (opts.card_id) db().run(`UPDATE cards SET llm_calls_used = llm_calls_used + 1 WHERE id = (SELECT root_id FROM cards WHERE id=?)`, opts.card_id);
    } catch { /* tracing must never break a call */ }
  }
}

function extractJson(raw: string): string {
  const t = raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "");
  const a = t.indexOf("{");
  const b = t.lastIndexOf("}");
  return a >= 0 && b > a ? t.slice(a, b + 1) : t;
}

/** Repetition collapse guard (§11): share of repeated 8-grams in long outputs. */
export function isRepetitive(text: string): boolean {
  if (text.length < config.guards.repetition_min_chars) return false;
  const w = text.split(/\s+/).filter(Boolean);
  if (w.length < 40) {
    // few "words" but long: check repeated lines instead
    const lines = text.split("\n").filter((l) => l.trim());
    return lines.length > 10 && new Set(lines).size / lines.length < 0.3;
  }
  const grams = new Map<string, number>();
  for (let i = 0; i + 8 <= w.length; i++) {
    const g = w.slice(i, i + 8).join(" ");
    grams.set(g, (grams.get(g) ?? 0) + 1);
  }
  let repeated = 0;
  for (const c of grams.values()) if (c > 1) repeated += c;
  return repeated / Math.max(1, w.length - 7) > 0.5;
}

interface StreamResult {
  text: string;
  provider: string;
  tin: number;
  tout: number;
  cost: number;
}

async function stream(p: Profile, prompt: string, schema: Schema | null, opts: CallOpts): Promise<StreamResult> {
  const body: Record<string, any> = {
    model: p.model,
    messages: [{ role: "user", content: prompt }],
    max_tokens: opts.maxTokens,
    temperature: opts.temperature ?? p.temperature,
    stream: true,
    usage: { include: true },
  };
  if (!p.thinking) {
    body.reasoning = { enabled: false }; // OpenRouter
    body.chat_template_kwargs = { enable_thinking: false }; // llama.cpp / vLLM
  }
  if (p.provider) body.provider = p.provider;
  if (schema) {
    body.response_format = { type: "json_schema", json_schema: { name: "output", strict: true, schema: wireSchema(schema) } };
  }
  const ac = new AbortController();
  let idle: ReturnType<typeof setTimeout> | undefined;
  const arm = () => {
    clearTimeout(idle);
    idle = setTimeout(() => ac.abort(new LLMFailure("timeout", "idle timeout")), p.idle_timeout_s * 1000);
  };
  arm();
  try {
    let res: Response | null = null;
    for (let i = 0; i < 4; i++) {
      res = await fetch(`${p.base_url}/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${p.api_key}` },
        body: JSON.stringify(body),
        signal: ac.signal,
      });
      // rate limit / overloaded before any generation: safe to retry (nothing is running server-side)
      if (res.status !== 429 && res.status !== 502 && res.status !== 503) break;
      await res.body?.cancel();
      await new Promise((r) => setTimeout(r, 1500 * 2 ** i));
      arm();
    }
    if (!res!.ok) throw new LLMFailure("transport", `HTTP ${res!.status}: ${(await res!.text()).slice(0, 300)}`);
    const reader = res!.body!.pipeThrough(new TextDecoderStream()).getReader();
    let buf = "", text = "", provider = "", tin = 0, tout = 0, cost = 0, wsRun = 0;
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      arm();
      buf += value;
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line.startsWith("data:")) continue;
        const data = line.slice(5).trim();
        if (data === "[DONE]") continue;
        let ev: any;
        try {
          ev = JSON.parse(data);
        } catch {
          continue;
        }
        if (ev.error) throw new LLMFailure("transport", JSON.stringify(ev.error).slice(0, 300));
        provider ||= ev.provider ?? "";
        const delta = ev.choices?.[0]?.delta?.content ?? "";
        if (delta) {
          text += delta;
          // whitespace watchdog: abort on a long run of whitespace
          const m = delta.match(/\s*$/)![0].length;
          wsRun = m === delta.length ? wsRun + m : m;
          if (wsRun > config.guards.whitespace_run_limit) {
            ac.abort();
            throw new LLMFailure("whitespace", "unbounded whitespace");
          }
        }
        if (ev.usage) {
          tin = ev.usage.prompt_tokens ?? 0;
          tout = ev.usage.completion_tokens ?? 0;
          cost = ev.usage.cost ?? 0;
        }
      }
    }
    return { text, provider, tin, tout, cost };
  } catch (e) {
    if (ac.signal.aborted && ac.signal.reason instanceof LLMFailure) throw ac.signal.reason;
    throw e;
  } finally {
    clearTimeout(idle);
  }
}
