// LLM gateway (DESIGN §10, §11). Every model call goes through here.
// - JSON calls run under a JSON schema; output is validated and repaired locally.
// - Every call sets max_tokens. Streaming with an idle timeout; no resend after a timeout.
// - Guards: whitespace watchdog, repetition detection. One retry on parse/repetition errors.
// - Every call is logged to llm_calls, linked to its session, card, topic and step, with the model's
//   reasoning trace (if the engine streams one) kept apart from its output, also for failed calls.

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
  temperature?: number | null;
  /** call-specific repair applied before validation (engine quirks, §10.2); must log what it changed */
  repair?: (v: any) => { value: any; note?: string };
}

export class LLMFailure extends Error {
  constructor(public kind: string, msg: string) {
    super(msg);
  }
}

// ---- reachability (§13): transport errors and timeouts mean the server can't be reached; any answer means it can ----
type HealthListener = (reachable: boolean, e?: LLMFailure) => void;
const healthListeners = new Set<HealthListener>();
export function onModelHealth(fn: HealthListener) {
  healthListeners.add(fn);
  return () => healthListeners.delete(fn);
}
function reportHealth(reachable: boolean, e?: LLMFailure) {
  for (const l of healthListeners) {
    try {
      l(reachable, e);
    } catch (err) {
      console.error("model health listener:", err);
    }
  }
}

// ---- spend tracking (the benchmark key is budget-limited) ----
export const spend = { usd: 0, calls: 0, byType: {} as Record<string, { calls: number; usd: number; tin: number; tout: number }> };

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
  const budget = config.budget_usd;
  if (budget && spend.usd > budget) throw new LLMFailure("budget", `spend limit ${budget} USD reached`);
  const id = newId("cal");
  const row: Record<string, any> = {
    id, call_type: callType, prompt_version: opts.version ?? "v1", model_profile: profileName, model: p.model,
    session_id: opts.session_id, card_id: opts.card_id, topic_id: opts.topic_id, step: opts.step, attempt,
    input: prompt, schema: schema ? JSON.stringify(schema) : null, at: nowIso(),
  };
  const tags = ctx().tags;
  if (tags) row.eval_label = JSON.stringify({ tags });
  const s = slotsFor(profileName, p);
  await s.acquire(opts.priority ?? "normal");
  const started = Date.now(); // ms: the call itself, not the wait for a slot
  const out: StreamOut = { text: "", reasoning: "" };
  try {
    const res = await stream(p, prompt, schema, opts, out);
    const raw = res.text;
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
    const err = e instanceof LLMFailure ? e : new LLMFailure("transport", transportMessage(e as Error));
    row.error = `${err.kind}: ${err.message}`;
    throw err;
  } finally {
    s.release();
    const kind = String(row.error ?? "").split(":")[0];
    if (kind === "transport" || kind === "timeout") reportHealth(false, new LLMFailure(kind, String(row.error).slice(kind.length + 2)));
    else reportHealth(true);
    row.raw_output = out.text;
    if (out.reasoning) row.reasoning = out.reasoning;
    row.ms = Date.now() - started;
    try {
      db().insert("llm_calls", row);
      if (opts.card_id) db().run(`UPDATE cards SET llm_calls_used = llm_calls_used + 1 WHERE id = (SELECT root_id FROM cards WHERE id=?)`, opts.card_id);
    } catch { /* tracing must never break a call */ }
  }
}

/** fetch only says "fetch failed"; the reason (URL, refused, TLS, DNS) is in its cause. */
function transportMessage(e: Error): string {
  const cause = e.cause instanceof Error ? e.cause.message : "";
  let msg = cause && !e.message.includes(cause) ? `${e.message}: ${cause}` : e.message;
  if (/certificate|UnknownIssuer/i.test(msg)) msg += " (custom CA? set DENO_TLS_CA_STORE=system,mozilla)";
  return msg;
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

/** Filled while streaming, so a failed call still leaves what the model produced. */
interface StreamOut {
  text: string;
  reasoning: string;
}

/** Engines without a reasoning parser put the trace inline, as a leading <think> block. */
export function splitThink(text: string): { text: string; reasoning: string } {
  const m = text.match(/^\s*<think>([\s\S]*?)(?:<\/think>|$)/);
  return m ? { text: text.slice(m[0].length), reasoning: m[1].trim() } : { text, reasoning: "" };
}

interface StreamResult {
  text: string;
  provider: string;
  tin: number;
  tout: number;
  cost: number;
}

const USER_AGENT = "sandman/5.2";
// calls outside any session/card/topic share one id per process
const PROCESS_SESSION = newId("proc");

const REASONING_BUDGET_MESSAGE = "\n\nThinking time is up, I'll answer now.\n";

async function stream(p: Profile, prompt: string, schema: Schema | null, opts: CallOpts, out: StreamOut): Promise<StreamResult> {
  const thinking = p.reasoning_effort !== "none";
  const body: Record<string, any> = {
    model: p.model,
    messages: [{ role: "user", content: prompt }],
    max_tokens: opts.maxTokens + (thinking ? p.reasoning_tokens : 0),
    stream: true,
    usage: { include: true }, // OpenRouter
    stream_options: { include_usage: true }, // llama.cpp, vLLM: token counts in the stream
    // OpenRouter: only providers that support every parameter sent (the JSON schema, reasoning)
    provider: { require_parameters: true },
  };
  const temperature = opts.temperature ?? p.temperature;
  if (temperature != null) body.temperature = temperature; // otherwise the provider's default
  // reasoning_effort "none" turns reasoning off; any other value is passed on as the effort
  if (thinking) {
    body.reasoning = { effort: p.reasoning_effort };
    if (p.reasoning_tokens > 0) {
      // llama.cpp: cut the reasoning off at the budget, so the answer's max_tokens share stays free
      body.reasoning_budget_tokens = p.reasoning_tokens;
      body.reasoning_budget_message = REASONING_BUDGET_MESSAGE;
    }
  } else {
    body.reasoning = { enabled: false }; // OpenRouter
    body.chat_template_kwargs = { enable_thinking: false }; // llama.cpp / vLLM
  }
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
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${p.api_key}`,
          "User-Agent": USER_AGENT,
          // OpenCode Go: stable id per conversation, for routing and prompt caching (ignored elsewhere)
          "x-opencode-session": opts.session_id ?? opts.card_id ?? opts.topic_id ?? PROCESS_SESSION,
        },
        body: JSON.stringify(body),
        signal: ac.signal,
      });
      // rate limit / overloaded before any generation: safe to retry (nothing is running server-side)
      if ((res.status !== 429 && res.status !== 502 && res.status !== 503) || i === 3) break; // last one: report its error
      await res.body?.cancel();
      await new Promise((r) => setTimeout(r, 1500 * 2 ** i));
      arm();
    }
    if (!res!.ok) throw new LLMFailure("transport", `HTTP ${res!.status}: ${(await res!.text()).slice(0, 300)}`);
    const reader = res!.body!.pipeThrough(new TextDecoderStream()).getReader();
    let buf = "", provider = "", tin = 0, tout = 0, cost = 0, wsRun = 0;
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
        const d = ev.choices?.[0]?.delta;
        // reasoning trace: `reasoning` (OpenRouter), `reasoning_content` (llama.cpp / vLLM)
        const think = d?.reasoning ?? d?.reasoning_content ?? "";
        if (typeof think === "string") out.reasoning += think;
        const delta = d?.content ?? "";
        if (delta) {
          out.text += delta;
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
    const inline = splitThink(out.text);
    if (inline.reasoning) {
      out.text = inline.text;
      out.reasoning = [out.reasoning, inline.reasoning].filter(Boolean).join("\n\n");
    }
    return { text: out.text, provider, tin, tout, cost };
  } catch (e) {
    if (ac.signal.aborted && ac.signal.reason instanceof LLMFailure) throw ac.signal.reason;
    throw e;
  } finally {
    clearTimeout(idle);
  }
}
