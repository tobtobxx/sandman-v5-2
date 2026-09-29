// Worker sessions (DESIGN §5.7): a loop of worker_step calls, one action each.
// The harness executes tools, dedupes repeated calls, pages long results and records what happened.

import { db, j, nowIso, Row } from "../db.ts";
import { newId } from "../ids.ts";
import { config } from "../config.ts";
import { llmJson, llmText, LLMFailure } from "../llm/gateway.ts";
import { generateContent, workerStep } from "../prompts/work.ts";
import { addComment, Card, children, comments, getCard, maxSteps, transition } from "./board.ts";
import { contentBlock, web } from "../tools/web.ts";
import { getArtifact, page, saveArtifact, wordCount } from "../tools/artifacts.ts";
import { findNotes, profileText, renderNotes } from "../memory/retriever.ts";
import { endSession, lastLlmCallId, startSession } from "../trace.ts";
import { createQuestion } from "../conversation/questions.ts";
import { failCard } from "./policy.ts";
import { emit } from "../events.ts";
import { addNegativeFact, PRICE } from "../memory/facts.ts";
import { fmtNow } from "../conversation/when.ts";

export type Outcome = "finish" | "block" | "fail";

// ---- context rendering ----
export function cardArtifacts(card: Card): Row[] {
  const ids = [card.id, ...children(card.id).map((c) => c.id), ...card.inputs.filter((i) => i.startsWith("card:")).map((i) => i.slice(5))];
  const arts = db().all(`SELECT id, name, bytes, content, origin, card_id FROM artifacts WHERE card_id IN (${ids.map(() => "?").join(",")}) ORDER BY created_at`, ...ids);
  for (const i of card.inputs.filter((i) => i.startsWith("art:"))) {
    const a = getArtifact(i.slice(4));
    if (a) arts.push(a);
  }
  return arts;
}

export function resultLines(title: string, state: string, r: Row | null): string {
  if (!r) return `### ${title} (${state})\nNo result.`;
  const out = [`### ${title} (${state})`, `Summary: ${r.summary ?? ""}`];
  if (r.recommendation) out.push(`Recommendation: ${r.recommendation}`);
  if (r.items?.length) out.push(`Items:\n${r.items.map((i: Row) => `- ${i.name}: ${i.note}`).join("\n")}`);
  if (r.facts?.length) out.push(`Facts:\n${r.facts.map((f: Row) => `- ${f.claim} (${f.source})`).join("\n")}`);
  if (r.open_questions?.length) out.push(`Open questions: ${r.open_questions.join("; ")}`);
  if (r.reason) out.push(`Reason: ${r.reason}`);
  return out.join("\n");
}

export function renderInputs(card: Card): string {
  const parts: string[] = [];
  if (card.phase === "synthesize") {
    for (const ch of children(card.id)) parts.push(resultLines(ch.title, ch.state, ch.result));
  }
  for (const i of card.inputs) {
    if (i.startsWith("card:")) {
      const c = getCard(i.slice(5));
      parts.push(resultLines(c.title, c.state, c.result));
    } else if (i.startsWith("url:")) parts.push(`Link from the owner: ${i.slice(4)}`);
  }
  const arts = cardArtifacts(card).filter((a) => a.origin !== "tool_result" || a.card_id === card.id);
  if (arts.length) parts.push(`Saved files:\n${arts.map((a) => `- ${a.id} — ${a.name} — ${wordCount(a.content)} words`).join("\n")}`);
  return parts.join("\n\n");
}

export async function memoryFor(card: Card): Promise<string> {
  return renderNotes(await findNotes(`${card.title} ${card.goal}`));
}

/** Harness-recorded facts (P12), from tool_calls of all sessions of this card. */
export function recordedFacts(card_id: string): { lines: string[]; files: Row[] } {
  const calls = db().all(
    `SELECT t.* FROM tool_calls t JOIN sessions s ON s.id = t.session_id WHERE s.card_id=? AND t.deduplicated=0 ORDER BY t.at`,
    card_id,
  );
  const out: string[] = [];
  for (const t of calls) {
    const a = j<Row>(t.args, {});
    if (t.tool === "web_search") out.push(`Searched: "${a.query}"`);
    if (t.tool === "web_fetch") out.push(`Fetched: ${a.url}${t.ok ? "" : " (failed)"}`);
  }
  const files = db().all(`SELECT * FROM artifacts WHERE card_id=? AND origin='write'`, card_id);
  for (const f of files) out.push(`Wrote ${f.name} (${wordCount(f.content)} words)`);
  return { lines: out, files };
}

// ---- tools ----
interface ToolResult {
  text: string;
  ok: boolean;
  artifact_id?: string;
}

async function runTool(card: Card, tool: string, args: Row): Promise<ToolResult> {
  switch (tool) {
    case "web_search": {
      const hits = await web.search(String(args.query ?? ""));
      if (!hits.length) return { ok: true, text: "No results. Try different words." };
      return { ok: true, text: contentBlock({}, hits.map((h, i) => `${i + 1}. ${h.title}\n   ${h.url}\n   ${h.snippet}`).join("\n")) };
    }
    case "web_fetch": {
      const url = String(args.url ?? "");
      const p = await web.fetch(url);
      if (!p) return { ok: false, text: `Could not load ${url}. Try another page.` };
      const content = `${p.title}\n\n${p.text}`;
      if (content.length <= config.tool_result_window) return { ok: true, text: `[${content.length} characters from ${url}.]\n${contentBlock({}, content)}` };
      const art = saveArtifact({ card_id: card.id, name: url, content, origin: "tool_result", summary: p.title });
      return { ok: true, text: page(art, 0, url), artifact_id: art.id };
    }
    case "read_artifact": {
      const art = getArtifact(String(args.id ?? ""));
      if (!art) return { ok: false, text: `There is no saved file ${args.id}. The saved files are listed under Inputs or in earlier results.` };
      return { ok: true, text: page(art, Number(args.from_char ?? 0), art.name), artifact_id: art.id };
    }
    case "write_artifact": {
      const name = String(args.name ?? "output.md");
      const p = generateContent({ title: card.title, goal: card.goal, inputs: renderInputs(card), memory: await memoryFor(card), name, what: String(args.what ?? ""), owner: `${config.owner.name}\n${profileText()}`.trim(), today: fmtNow() });
      const text = await llmText("generate_content", p.prompt, { maxTokens: p.maxTokens, version: p.version, card_id: card.id });
      const art = saveArtifact({ card_id: card.id, name, content: text, origin: "write", summary: String(args.what ?? "").slice(0, 200) });
      const preview = text.split("\n").filter((l) => l.trim()).slice(0, 3).join("\n");
      return { ok: true, artifact_id: art.id, text: `Saved ${name} as ${art.id} (${wordCount(text)} words). It begins:\n${preview}\nIf the task is done, finish now.` };
    }
  }
  return { ok: false, text: `Unknown tool ${tool}.` };
}

const argsHash = (tool: string, args: Row) => `${tool}:${JSON.stringify(args, Object.keys(args).sort()).toLowerCase().replace(/\s+/g, " ")}`;

// ---- the session loop ----
export async function runWorker(card_id: string): Promise<Outcome> {
  let card = getCard(card_id);
  card = transition(card.id, "running", "claimed", "dispatcher", {
    lease_owner: "local",
    lease_expires_at: new Date(Date.now() + config.board.lease_seconds * 1000).toISOString(),
  });
  const session_id = startSession(card.phase === "synthesize" ? "synthesis" : "worker", { card_id: card.id, topic_id: card.origin_topic_id ?? undefined });
  const role = card.role;
  const n = maxSteps(role);
  const withItems = !!card.recipe_step && recipeStepHasItems(card);
  const steps: string[] = [];
  const hashes = new Map<string, number>();
  let dupRun = 0;
  const profile = profileText();
  const memory = await memoryFor(card);

  for (let k = 1; k <= n; k++) {
    card = getCard(card.id);
    if (card.state !== "running") return endSession(session_id, "interrupted", k - 1), "fail";
    // applicability (P4): read_artifact only when something is saved
    const tools = config.worker_roles[role].tools.filter((t) => t !== "read_artifact" || cardArtifacts(card).length > 0);
    const cmts = comments(card.id).map((c) => `${c.author}: ${c.body}`);
    const p = workerStep({
      role, tools, withItems, owner: profile, title: card.title, goal: card.goal, done_when: card.done_when, constraints: card.constraints,
      memory, inputs: renderInputs(card), comments: cmts, steps, step: k, maxSteps: n,
    });
    let action: Row;
    try {
      action = await llmJson("worker_step", p.prompt, p.schema, {
        maxTokens: p.maxTokens, version: p.version, session_id, card_id: card.id, step: k,
        // quirk: some engines don't enforce anyOf/const, and the model writes the tool name as the action
        repair: (v) => tools.includes(v?.action) ? { value: { action: "tool", tool: v.action, tool_args: v.tool_args ?? {} }, note: "$.action: tool name → tool action" } : { value: v },
      });
    } catch (e) {
      if (!(e instanceof LLMFailure)) throw e;
      steps.push(`Step ${k}: (your output was invalid and was ignored)`);
      continue;
    }
    db().run(`UPDATE sessions SET steps=? WHERE id=?`, k, session_id);
    db().run(`UPDATE cards SET lease_expires_at=? WHERE id=?`, new Date(Date.now() + config.board.lease_seconds * 1000).toISOString(), card.id);

    if (action.action === "tool") {
      const h = argsHash(action.tool, action.tool_args ?? {});
      const tcl: Row = { id: newId("tcl"), session_id, llm_call_id: lastLlmCallId(session_id), step: k, tool: action.tool, args: action.tool_args, args_hash: h, at: nowIso() };
      const argStr = JSON.stringify(action.tool_args);
      if (hashes.has(h)) {
        dupRun++;
        const text = `You already did exactly this in step ${hashes.get(h)}; its result is above. Choose a different action.`;
        db().insert("tool_calls", { ...tcl, deduplicated: 1, result_text: text, ok: 0, ms: 0 });
        steps.push(`Step ${k}: ${action.tool}(${argStr})\nResult: ${text}`);
        if (dupRun > config.guards.max_duplicate_calls) {
          endSession(session_id, "fail:duplicates", k);
          await failCard(card.id, "tool_error", "The session repeated the same tool call three times.");
          return "fail";
        }
        continue;
      }
      dupRun = 0;
      hashes.set(h, k);
      const t0 = Date.now();
      let r: ToolResult;
      try {
        r = await runTool(card, action.tool, action.tool_args ?? {});
      } catch (e) {
        r = { ok: false, text: `The tool failed: ${(e as Error).message}` };
      }
      db().insert("tool_calls", { ...tcl, result_text: r.text, result_artifact_id: r.artifact_id, ok: r.ok ? 1 : 0, ms: Date.now() - t0 });
      emit("session.step", { ref_id: session_id, payload: { card_id: card.id, step: k, tool: action.tool } });
      steps.push(`Step ${k}: ${action.tool}(${argStr})\nResult:\n${r.text}`);
      continue;
    }
    if (action.action === "finish") {
      endSession(session_id, "finish", k);
      for (const f of action.result?.facts ?? []) if (PRICE.test(f.claim ?? "")) f.volatility = "volatile";
      transition(card.id, "verifying", "finish", "worker", { result: { ...action.result, source: "worker" }, result_source: "worker", lease_owner: null });
      return "finish";
    }
    if (action.action === "block") {
      endSession(session_id, "block", k);
      const q = createQuestion({ card_id: card.id, topic_id: card.origin_topic_id, text: action.question, options: action.question_options ?? [], reason: "worker_question" });
      transition(card.id, "blocked", "block", "worker", { blocked_reason: "worker_question", lease_owner: null }, { question_id: q.id, analysis: action.analysis });
      return "block";
    }
    if (action.action === "fail" && role === "research" && action.category !== "out_of_scope" && !withItems) {
      // "not found" is a result, not a failure: the verifier decides whether it is acceptable
      endSession(session_id, "finish:not_found", k);
      addNegativeFact(card, action.analysis);
      const result = { summary: `Not found. ${action.analysis}`, facts: [], open_questions: [], sources: [], source: "worker" };
      transition(card.id, "verifying", "finish_not_found", "worker", { result, result_source: "worker", lease_owner: null });
      return "finish";
    }
    if (action.action === "fail") {
      endSession(session_id, `fail:${action.category}`, k);
      await failCard(card.id, action.category, action.analysis);
      return "fail";
    }
  }
  endSession(session_id, "fail:steps_exhausted", n);
  await failCard(card.id, "tool_error", `Used all ${n} steps without finishing.`);
  return "fail";
}

import { getRecipe } from "./recipes.ts";
function recipeStepHasItems(card: Card): boolean {
  const r = card.recipe_id ? getRecipe(card.recipe_id) : null;
  return !!r?.steps.find((s) => s.key === card.recipe_step)?.result_items;
}
