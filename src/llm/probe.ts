// Quirk probe (DESIGN §10.2): a few fixed calls that reveal how an engine behaves under a schema.

import { llmJson, llmText } from "./gateway.ts";
import { isRole, modelSlug } from "../config.ts";
import { obj, str } from "./schema.ts";
import { db } from "../db.ts";

/** `name`: a model slug, or a role (its model is probed). */
export async function probe(name = "main") {
  const found: string[] = [];
  const model = isRole(name) ? modelSlug(name) : name;
  const opts = { maxTokens: 300, model };

  // 1. key order: schema lists zeta before alpha; does output follow schema order or alphabetical?
  const s1 = { type: "object", properties: { zeta: str(), alpha: str() }, required: ["zeta", "alpha"], additionalProperties: false };
  await llmJson("probe_order", 'Give zeta="z" and alpha="a".', s1, opts);
  const raw1 = db().get(`SELECT raw_output FROM llm_calls WHERE call_type='probe_order' ORDER BY rowid DESC`)!.raw_output as string;
  if (raw1.indexOf('"alpha"') < raw1.indexOf('"zeta"')) found.push("keys_alphabetical");
  if (/^\s{3,}/.test(raw1)) found.push("unbounded_whitespace(leading)");

  // 2. maxLength enforcement
  const s2 = obj({ text: str(20) });
  await llmJson("probe_maxlen", "Describe the sea in two or three sentences in the field text.", s2, opts);
  const raw2 = JSON.parse(db().get(`SELECT raw_output FROM llm_calls WHERE call_type='probe_maxlen' ORDER BY rowid DESC`)!.raw_output);
  if ((raw2.text ?? "").length > 20) found.push("ignores_maxLength");

  // 3. newlines inside JSON strings
  const r3 = await llmJson<{ poem: string }>("probe_newlines", "Write a 4-line poem in the field poem, one line per verse.", obj({ poem: str() }), opts);
  if (!r3.poem.includes("\n")) found.push("drops_newlines_in_strings");

  // 4. plain text works
  const t = await llmText("probe_text", "Say hello in three words.", { maxTokens: 20, model });
  if (!t) found.push("empty_text");

  return found;
}
