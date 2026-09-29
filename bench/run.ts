// sandman bench [filter...] [--full] [--repeat N] [--concurrency N] [--label name] [--no-save]
// Runs the hard cases (HARD below), or every case with --full; filters narrow either set.
// Runs each case in a fresh in-memory database, with the offline corpus and a fixed clock.
// Writes bench/results/<stamp>-<label>.json + bench/results/latest.md, and copies all traces into
// data/bench.db (open it with deno task serve --db data/bench.db → /observer).

import { DB, withCtx } from "../src/db.ts";
import { config } from "../src/config.ts";
import { spend } from "../src/llm/gateway.ts";
import { seedRecipes } from "../src/work/recipes.ts";
import { installHooks } from "../src/work/dispatcher.ts";
import { Case, Check, group, judge, NOW, ownerProfile } from "./lib.ts";

const CASE_FILES = ["segment", "route", "desk", "triage", "planner", "worker", "verifier", "librarian", "memory", "answers", "episodes"];

// The cases that still fail now and then: each failed at least once in the last five saved runs
// (v7, v8, v9, v10-worker, chat-v1). The rest pass reliably and only prove the floor; run them with
// --full before a release or after a change that touches every role.
const HARD = [
  "answers/model-free-text",
  "desk/answer-one-of-two",
  "desk/conversation-work-goes-to-topic",
  "desk/status-from-context",
  "episode/capture-no-cross-talk",
  "episode/capture-three-items",
  "episode/compare-card",
  "episode/memory-reuse",
  "librarian/negative-note",
  "memory/duplicate",
  "memory/new-claim",
  "memory/relevance-trivial",
  "planner/generate-trip",
  "segment/background-then-request",
  "segment/one-long-subject",
  "segment/research-then-message-about-it",
  "triage/big-trip-plan",
  "triage/compare-three-named",
  "triage/write-missing-info",
  "verifier/file-claimed-not-written",
  "verifier/not-available-ok",
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
  config.web.backend = "corpus";
  config.profiles.small.slots = 8;
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
  const save = !args.includes("--no-save");
  const full = args.includes("--full");
  const filters = args.filter((a) => !a.startsWith("--"));
  const allCases = await loadCases();
  const missing = HARD.filter((id) => !allCases.some((c) => c.id === id));
  if (missing.length) console.warn(`HARD lists unknown cases: ${missing.join(", ")}`);
  let cases = full ? allCases : allCases.filter((c) => HARD.includes(c.id));
  if (filters.length) cases = cases.filter((c) => filters.some((f) => c.id.includes(f)));
  const set = full ? "full" : "hard";
  console.log(`${cases.length} cases (${set} set) × ${repeat}  (model ${config.profiles.small.model}, judge ${config.profiles.judge.model})`);

  const traceDb = save ? new DB("data/bench.db") : null;
  if (traceDb) for (const t of TRACE_TABLES) traceDb.run(`DELETE FROM ${t}`);
  const results: Result[] = [];
  const queue: [Case, number][] = [];
  for (let r = 1; r <= repeat; r++) for (const c of cases) queue.push([c, r]);
  const t0 = Date.now();

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
    });
    if (traceDb) exportTraces(cdb, traceDb, c.id, run);
    results.push(res);
    const mark = res.error ? "ERR " : res.pass ? "pass" : "FAIL";
    console.log(`${mark} ${c.id}${repeat > 1 ? ` #${run}` : ""}  (${res.calls} calls, ${(res.ms / 1000).toFixed(1)}s)${res.error ? "  " + res.error : res.detail && !res.pass ? "  " + res.detail.slice(0, 300) : ""}`);
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
  const lines = [
    `# Bench ${label} — ${new Date().toISOString()}`,
    ``,
    `Model: ${config.profiles.small.model} (thinking off). Judge: ${config.profiles.judge.model}. Set: ${set} (${cases.length} of ${allCases.length} cases). Repeats: ${repeat}.`,
    `**${total}/${results.length} passed (${((100 * total) / results.length).toFixed(1)}%)** — ${results.reduce((a, r) => a + r.calls, 0)} target calls, $${spend.usd.toFixed(4)} total incl. judge, ${((Date.now() - t0) / 1000).toFixed(0)}s`,
    ``,
    `| group | pass | rate | calls | cost $ |`,
    `|---|---|---|---|---|`,
    ...rows.map((r) => `| ${r.group} | ${r.pass}/${r.cases} | ${(100 * r.rate).toFixed(0)}% | ${r.calls} | ${r.cost.toFixed(4)} |`),
    ``,
    `## Failures`,
    ``,
    ...results.filter((r) => !r.pass).sort((a, b) => a.id.localeCompare(b.id)).map((r) => `- **${r.id}**${repeat > 1 ? ` #${r.run}` : ""}: ${(r.error ?? r.detail ?? "").replace(/\n/g, " ").slice(0, 400)}`),
  ];
  console.log("\n" + lines.join("\n"));
  if (save) {
    Deno.mkdirSync("bench/results", { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    Deno.writeTextFileSync(`bench/results/${stamp}-${label}.json`, JSON.stringify({ label, model: config.profiles.small.model, set, repeat, spend, results }, null, 1));
    Deno.writeTextFileSync(`bench/results/latest.md`, lines.join("\n") + "\n");
  }
}
