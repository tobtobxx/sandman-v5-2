// Model probe: a few fixed calls against one model, to check a new engine or quantization before the
// benchmark. Reports the endpoint's settings and, per call, outcome, latency, tokens, speed, cost and
// what local validation had to repair.

import { LLMFailure, llmJson, llmText } from "./gateway.ts";
import { config, isRole, modelSlug } from "../config.ts";
import { obj, str } from "./schema.ts";
import { db } from "../db.ts";

const CALLS: { type: string; run: (opts: { maxTokens: number; model: string }) => Promise<unknown> }[] = [
  {
    type: "probe_json",
    run: (o) => llmJson("probe_json", 'Give zeta="z" and alpha="a".', obj({ zeta: str(), alpha: str() }), o),
  },
  {
    type: "probe_maxlen",
    run: (o) => llmJson("probe_maxlen", "Describe the sea in two or three sentences in the field text.", obj({ text: str(20) }), o),
  },
  {
    type: "probe_text",
    run: (o) => llmText("probe_text", "Write four sentences about the sea.", { ...o, maxTokens: 200 }),
  },
];

/** `name`: a model slug, or a role (its model is probed). Returns false if every call failed. */
export async function probe(name = "main"): Promise<boolean> {
  const slug = isRole(name) ? modelSlug(name) : name;
  const m = config.models[slug];
  if (!m) throw new Error(`no model "${slug}" in config.models`);
  console.log(`${slug}: ${m.model} @ ${m.base_url}`);
  console.log(
    `  reasoning_effort=${m.reasoning_effort} reasoning_tokens=${m.reasoning_tokens} temperature=${m.temperature ?? "default"} ` +
      `slots=${m.slots} idle_timeout_s=${m.idle_timeout_s}`,
  );

  let okCalls = 0;
  for (const c of CALLS) {
    try {
      await c.run({ maxTokens: 300, model: slug });
      okCalls++;
    } catch (e) {
      if (!(e instanceof LLMFailure)) throw e;
    }
  }

  const rows = db().all(
    `SELECT call_type, attempt, ok, error, repaired, provider, tokens_in, tokens_out, cost, ms, length(reasoning) reasoning_chars
     FROM llm_calls WHERE call_type LIKE 'probe_%' ORDER BY rowid`,
  );
  console.log();
  console.table(rows.map((r) => ({
    call: r.call_type,
    try: r.attempt,
    result: r.ok ? "ok" : r.error,
    ms: r.ms,
    "tok in": r.tokens_in ?? "",
    "tok out": r.tokens_out ?? "",
    "tok/s": r.tokens_out && r.ms ? Math.round(r.tokens_out / (r.ms / 1000)) : "",
    reasoning: r.reasoning_chars ?? 0,
    repairs: r.repaired ? JSON.parse(r.repaired).join("; ") : "",
    provider: r.provider ?? "",
  })));

  const sum = (k: string) => rows.reduce((a, r) => a + (r[k] ?? 0), 0);
  const ms = sum("ms"), tout = sum("tokens_out");
  console.log(
    `${okCalls}/${CALLS.length} calls ok, ${rows.length} requests · ${ms} ms · ${sum("tokens_in")} in / ${tout} out tokens` +
      (tout && ms ? ` · ${Math.round(tout / (ms / 1000))} tok/s overall` : "") + ` · $${sum("cost").toFixed(5)}`,
  );
  return okCalls > 0;
}
