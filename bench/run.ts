// sandman bench [filter...] [--full] [--repeat N] [--concurrency N] [--label name] [--no-save] [--min-pass PCT]
// Runs the hard cases (HARD below), or every case with --full; filters narrow either set.
// Runs each case in a fresh in-memory database, with the offline corpus and a fixed clock.
// Writes bench/results/<stamp>-<label>.json + bench/results/latest.md, and copies all traces into
// data/bench.db (set db_path to it in config.jsonc and open /observer).
// --min-pass exits with 1 when fewer than PCT % of case runs pass.

import { DB, withCtx } from "../src/db.ts";
import { config, modelFor, modelSlug } from "../src/config.ts";
import { spend } from "../src/llm/gateway.ts";
import { seedRecipes } from "../src/work/recipes.ts";
import { installHooks } from "../src/work/dispatcher.ts";
import { web } from "../src/tools/web.ts";
import * as corpus from "./corpus.ts";
import { Case, Check, group, judge, NOW, ownerProfile } from "./lib.ts";

const CASE_FILES = ["segment", "route", "desk", "triage", "planner", "worker", "verifier", "librarian", "memory", "search", "answers", "episodes"];

// The cases that fail now and then: each failed at least once in 20 full runs (bench/results
// *-i71-ab-base-x10 and *-i71-ab-tree-x10, 29 Sep 2026); the numbers are failures in those 20.
// The rest passed all 20 and only prove the floor; run them with --full before a release or after a
// change that touches every role.
// Episodes are not in this list: they cost most of a full run. Instead, the stage each one failed at
// is here as a unit case (issue #27); the episodes run with --full.
// planner/generate-trip is left out: it fails 18/20 until sequential recipes exist (#77), so it
// can't show a regression.
const HARD = [
  "desk/conversation-one-sentence", // 1
  "desk/new-work-no-fallback-only-criterion", // observer trace: fallback became its own criterion, 16/20
  "desk/research-reply-no-made-up-answer", // observer trace: reply invented opening hours, 17/20
  "desk/status-from-context", // 1
  "librarian/narrow-stale-price", // 10
  "librarian/negative-note", // 3
  "memory/relevance-trivial", // 1
  "memory/subject-same-kind-different-thing", // 3
  "planner/fill-choose-among", // 1
  "planner/pick-none", // 4
  "route/new-subject", // 1
  "segment/find-then-book-it", // 1
  "segment/no-cross-talk-memo", // 1; also episode/capture-no-cross-talk
  "segment/one-long-subject", // 2
  "triage/compare-three-named", // episode/compare-card (triage asked the owner)
  "triage/simple-lookup", // 1
  "triage/write-enough-info", // 1
  "triage/write-missing-info", // 3
  "worker/research-gather-named", // 2
  "worker/research-not-available-honest", // 1
  "worker/research-paging", // episode/research-card (never read past the first page)
  "worker/research-paging-facts", // episode/memory-reuse, 4 (the price not in facts)
];

async function loadCases(): Promise<Case[]> {
  const out: Case[] = [];
  for (const f of CASE_FILES) out.push(...(await import(`./cases/${f}.ts`)).cases);
  return out;
}

interface Result {
  id: string;
  group: string;
  run: number;
  pass: boolean;
  detail?: string;
  error?: string;
  calls: number;
  cost: number;
  tokens_in: number;
  tokens_out: number;
  ms: number;
  judged: boolean;
}

/** One model call, for the timing table. */
interface CallTime {
  profile: string;
  call_type: string;
  ok: boolean;
  ms: number;
  tokens_out: number;
}

interface TimingRow {
  profile: string;
  call_type: string;
  calls: number;
  ok: number;
  p50_ms: number;
  p90_ms: number;
  avg_tokens_out: number;
}

/** Per profile and call type: calls, successes, median and 90th-percentile time, output tokens. */
function timing(calls: CallTime[]): TimingRow[] {
  const by = new Map<string, CallTime[]>();
  for (const c of calls) by.set(`${c.profile}\t${c.call_type}`, [...(by.get(`${c.profile}\t${c.call_type}`) ?? []), c]);
  const pct = (xs: number[], p: number) => xs[Math.min(xs.length - 1, Math.floor(p * xs.length))];
  return [...by.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([k, cs]) => {
    const [profile, call_type] = k.split("\t");
    const ms = cs.map((c) => c.ms).sort((a, b) => a - b);
    return {
      profile, call_type, calls: cs.length, ok: cs.filter((c) => c.ok).length, p50_ms: pct(ms, 0.5), p90_ms: pct(ms, 0.9),
      avg_tokens_out: Math.round(cs.reduce((a, c) => a + c.tokens_out, 0) / cs.length),
    };
  });
}

const TRACE_TABLES = ["topics", "captures", "capture_items", "messages", "receipts", "questions", "review_items", "desk_turns", "cards", "card_deps", "card_events", "comments", "artifacts", "sessions", "tool_calls", "llm_calls", "notes", "claims", "facts", "events"];

function exportTraces(from: DB, to: DB, caseId: string, run: number) {
  for (const t of TRACE_TABLES) {
    for (const row of from.all(`SELECT * FROM ${t}`)) {
      if (t === "events" || t === "card_events") delete row.id;
      if (t === "llm_calls") row.eval_label = JSON.stringify({ tags: { case: caseId, run } });
      if (t === "topics") row.slug = `${row.slug}@${caseId}#${run}`;
      try {
        to.insert(t, row);
      } catch { /* duplicate ids across repeats are skipped */ }
    }
  }
}

export async function runBench(args: string[]) {
  Object.assign(web, corpus);
  try {
    modelSlug("judge");
  } catch {
    console.error(`The benchmark needs a judge: set roles.judge in the config.`);
    Deno.exit(1);
  }
  modelFor("main").slots = 8;
  const opt = (k: string, d: string) => {
    const i = args.indexOf(k);
    if (i < 0) return d;
    const v = args[i + 1];
    args.splice(i, 2);
    return v;
  };
  const repeat = Number(opt("--repeat", "1"));
  const concurrency = Number(opt("--concurrency", "6"));
  const label = opt("--label", "run");
  const minPass = Number(opt("--min-pass", "0"));
  const save = !args.includes("--no-save");
  const full = args.includes("--full");
  const filters = args.filter((a) => !a.startsWith("--"));
  const allCases = await loadCases();
  const missing = HARD.filter((id) => !allCases.some((c) => c.id === id));
  if (missing.length) console.warn(`HARD lists unknown cases: ${missing.join(", ")}`);
  let cases = full ? allCases : allCases.filter((c) => HARD.includes(c.id));
  if (filters.length) cases = cases.filter((c) => filters.some((f) => c.id.includes(f)));
  const set = full ? "full" : "hard";
  console.log(`${cases.length} cases (${set} set) × ${repeat}  (model ${modelFor("main").model}, judge ${modelFor("judge").model})`);

  const traceDb = save ? new DB("data/bench.db") : null;
  if (traceDb) for (const t of TRACE_TABLES) traceDb.run(`DELETE FROM ${t}`);
  const results: Result[] = [];
  const callTimes: CallTime[] = [];
  const queue: [Case, number][] = [];
  for (let r = 1; r <= repeat; r++) for (const c of cases) queue.push([c, r]);
  const t0 = Date.now();
  const runs = queue.length;
  /** "(11/45, 3 failed, ~4m left)": the estimate is elapsed time per finished case × cases left. */
  const progress = () => {
    const done = results.length, failed = results.filter((r) => !r.pass).length;
    const left = ((Date.now() - t0) / done) * (runs - done) / 1000;
    const eta = done === runs ? "" : `, ~${left >= 90 ? `${Math.round(left / 60)}m` : `${Math.round(left)}s`} left`;
    return `(${String(done).padStart(String(runs).length)}/${runs}${failed ? `, ${failed} failed` : ""}${eta})`;
  };

  async function one(c: Case, run: number) {
    const cdb = new DB(":memory:");
    const t = Date.now();
    const res: Result = { id: c.id, group: group(c), run, pass: false, calls: 0, cost: 0, tokens_in: 0, tokens_out: 0, ms: 0, judged: false };
    await withCtx({ db: cdb, now: () => new Date(NOW.getTime() + (Date.now() - t)), tags: { case: c.id } }, async () => {
      seedRecipes();
      installHooks();
      ownerProfile();
      try {
        const out = await c.run();
        let chk: Check = { pass: true };
        if (c.check) {
          const r = await c.check(out);
          chk = typeof r === "boolean" ? { pass: r } : r;
        }
        if (chk.pass && c.judge) {
          res.judged = true;
          chk = await judge(c.judge.criteria, c.judge.material(out));
        }
        res.pass = chk.pass;
        res.detail = chk.detail;
      } catch (e) {
        res.error = (e as Error).message;
      }
      const s = cdb.get(`SELECT count(*) n, coalesce(sum(cost),0) cost, coalesce(sum(tokens_in),0) tin, coalesce(sum(tokens_out),0) tout FROM llm_calls WHERE model_profile != 'judge'`)!;
      Object.assign(res, { calls: s.n, cost: s.cost, tokens_in: s.tin, tokens_out: s.tout, ms: Date.now() - t });
      for (const r of cdb.all(`SELECT model_profile, call_type, ok, ms, tokens_out FROM llm_calls WHERE model_profile != 'judge'`)) {
        callTimes.push({ profile: r.model_profile, call_type: r.call_type, ok: r.ok === 1, ms: r.ms ?? 0, tokens_out: r.tokens_out ?? 0 });
      }
    });
    if (traceDb) exportTraces(cdb, traceDb, c.id, run);
    results.push(res);
    const mark = res.error ? "ERR " : res.pass ? "pass" : "FAIL";
    console.log(`${progress()} ${mark} ${c.id}${repeat > 1 ? ` #${run}` : ""}  (${res.calls} calls, ${(res.ms / 1000).toFixed(1)}s)${res.error ? "  " + res.error : res.detail && !res.pass ? "  " + res.detail.slice(0, 300) : ""}`);
  }

  const workers = Array.from({ length: concurrency }, async () => {
    while (queue.length) {
      const [c, r] = queue.shift()!;
      await one(c, r);
    }
  });
  await Promise.all(workers);

  // ---- report ----
  const groups = [...new Set(results.map((r) => r.group))];
  const rows = groups.map((g) => {
    const rs = results.filter((r) => r.group === g);
    const p = rs.filter((r) => r.pass).length;
    return { group: g, cases: rs.length, pass: p, rate: p / rs.length, calls: rs.reduce((a, r) => a + r.calls, 0), cost: rs.reduce((a, r) => a + r.cost, 0) };
  });
  const total = results.filter((r) => r.pass).length;
  const times = timing(callTimes);
  const lines = [
    `# Bench ${label} — ${new Date().toISOString()}`,
    ``,
    `Model: ${modelFor("main").model} (reasoning ${modelFor("main").reasoning_effort}). Judge: ${modelFor("judge").model}. Set: ${set} (${cases.length} of ${allCases.length} cases). Repeats: ${repeat}.`,
    `**${total}/${results.length} passed (${((100 * total) / results.length).toFixed(1)}%)** — ${results.reduce((a, r) => a + r.calls, 0)} target calls, $${spend.usd.toFixed(4)} total incl. judge, ${((Date.now() - t0) / 1000).toFixed(0)}s`,
    ``,
    `| group | pass | rate | calls | cost $ |`,
    `|---|---|---|---|---|`,
    ...rows.map((r) => `| ${r.group} | ${r.pass}/${r.cases} | ${(100 * r.rate).toFixed(0)}% | ${r.calls} | ${r.cost.toFixed(4)} |`),
    ``,
    `## Time per call`,
    ``,
    `Measured from getting a slot to the end of the stream (queueing excluded); output tokens include reasoning where the server reports it.`,
    ``,
    `| profile | call type | calls | ok | p50 s | p90 s | tokens out |`,
    `|---|---|---|---|---|---|---|`,
    ...times.map((t) => `| ${t.profile} | ${t.call_type} | ${t.calls} | ${t.ok} | ${(t.p50_ms / 1000).toFixed(1)} | ${(t.p90_ms / 1000).toFixed(1)} | ${t.avg_tokens_out} |`),
    ``,
    `## Failures`,
    ``,
    ...results.filter((r) => !r.pass).sort((a, b) => a.id.localeCompare(b.id)).map((r) => `- **${r.id}**${repeat > 1 ? ` #${r.run}` : ""}: ${(r.error ?? r.detail ?? "").replace(/\n/g, " ").slice(0, 400)}`),
  ];
  console.log("\n" + lines.join("\n"));
  if (save) {
    Deno.mkdirSync("bench/results", { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    Deno.writeTextFileSync(`bench/results/${stamp}-${label}.json`, JSON.stringify({ label, model: modelFor("main").model, set, repeat, spend, timing: times, results }, null, 1));
    Deno.writeTextFileSync(`bench/results/latest.md`, lines.join("\n") + "\n");
  }
  const summary = Deno.env.get("GITHUB_STEP_SUMMARY");
  if (summary) Deno.writeTextFileSync(summary, lines.join("\n") + "\n", { append: true });
  const rate = results.length ? (100 * total) / results.length : 0;
  if (rate < minPass) {
    console.error(`\nPass rate ${rate.toFixed(1)}% is below --min-pass ${minPass}%.`);
    Deno.exit(1);
  }
}
