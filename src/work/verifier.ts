// Verification (DESIGN §5.8): one judge call per done_when criterion, with harness-recorded facts.

import { llmJson } from "../llm/gateway.ts";
import { verifyCriterion } from "../prompts/work.ts";
import { addComment, getCard, transition } from "./board.ts";
import { recordedFacts } from "./worker.ts";
import { endSession, startSession } from "../trace.ts";
import { config } from "../config.ts";
import { escalate } from "./policy.ts";
import { getRecipe } from "./recipes.ts";

export function resultText(r: Record<string, any> | null): string {
  if (!r) return "(no result)";
  const out = [`Summary: ${r.summary ?? ""}`];
  if (r.items?.length) out.push(`Items:\n${r.items.map((i: any) => `- ${i.name}: ${i.note}`).join("\n")}`);
  if (r.recommendation) out.push(`Recommendation: ${r.recommendation}`);
  if (r.facts?.length) out.push(`Facts:\n${r.facts.map((f: any) => `- ${f.claim}`).join("\n")}`);
  if (r.open_questions?.length) out.push(`Open questions: ${r.open_questions.join("; ")}`);
  if (r.sources?.length) out.push(`Sources: ${r.sources.join(", ")}`);
  return out.join("\n");
}

export async function verifyCard(card_id: string): Promise<"pass" | "fail"> {
  const card = getCard(card_id);
  if (!card.done_when.length) {
    transition(card.id, "done", "verified", "verifier");
    return "pass";
  }
  const session_id = startSession("verifier", { card_id: card.id });
  const r = card.recipe_id ? getRecipe(card.recipe_id) : null;
  const needsItems = !!r?.steps.find((s) => s.key === card.recipe_step)?.result_items;
  const rec = recordedFacts(card.id);
  const excerpts = rec.files.map((f) => `--- ${f.name} ---\n${String(f.content).slice(0, 2500)}`).join("\n\n");
  const fails: string[] = [];
  let step = 0;
  if (needsItems && !(card.result?.items ?? []).length) fails.push("The result lists no items. Put each candidate in items, with a name and one line why it fits.");
  for (const criterion of card.done_when) {
    const p = verifyCriterion({ criterion, result: resultText(card.result), recorded: rec.lines.join("\n"), excerpts });
    const r = await llmJson<{ analysis: string; verdict: string }>("verify_criterion", p.prompt, p.schema, {
      maxTokens: p.maxTokens, version: p.version, session_id, card_id: card.id, step: ++step,
    });
    if (r.verdict !== "pass") fails.push(`"${criterion}": ${r.analysis}`);
  }
  if (!fails.length) {
    endSession(session_id, "pass", step);
    transition(card.id, "done", "verified", "verifier");
    return "pass";
  }
  endSession(session_id, "fail", step);
  addComment(card.id, "verifier", `The result did not pass:\n${fails.join("\n")}`);
  if (card.result_source === "memory") {
    addComment(card.id, "librarian", `Memory suggested: ${card.result?.summary ?? ""}`);
    transition(card.id, "ready", "memory_insufficient", "verifier", { result: null, result_source: null });
  } else if (card.attempt < config.board.max_attempts) {
    transition(card.id, "ready", "verify_failed", "verifier", { attempt: card.attempt + 1 });
  } else {
    escalate(card.id, `The result failed its checks twice. ${fails[0]}`);
  }
  return "fail";
}
