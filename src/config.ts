// Configuration (DESIGN §17). Settings a deployment changes live in config.jsonc, with defaults in
// config.default.jsonc; the rest are tuning defaults below. Without a config.jsonc, `loadConfig`
// writes the commented default and exits.

/** One model endpoint under "models" in config.jsonc, keyed by a slug the owner chooses. */
export interface ModelConfig {
  base_url: string;
  model: string;
  api_key: string;
  // "none": reasoning off; anything else is sent as the reasoning effort
  reasoning_effort: string;
  // Unless reasoning is off: the reasoning budget (llama.cpp), also added to every call's max_tokens; 0: none
  reasoning_tokens: number;
  slots: number;
  // null: the provider's default
  temperature: number | null;
  idle_timeout_s: number;
  // embedding models only
  query_prefix?: string;
  document_prefix?: string;
  min_similarity?: number;
}

/** Values for the keys a model entry leaves out. `base_url` and `model` have none. */
const MODEL_DEFAULTS = {
  api_key: "", reasoning_effort: "none", reasoning_tokens: 0, slots: 1, temperature: null, idle_timeout_s: 60,
};
const MODEL_KEYS = ["base_url", "model", ...Object.keys(MODEL_DEFAULTS), "query_prefix", "document_prefix", "min_similarity"];

/** What the code asks a model for. config.jsonc assigns each role a model slug, or null. */
export type ModelRole = "main" | "interactive" | "embedding" | "judge";
/** What a role set to null does: run on another role's model, stop at startup ("required"),
 *  or fail only when something uses it ("on_use"). Documented in config.default.jsonc. */
const WHEN_NULL: Record<ModelRole, ModelRole | "required" | "on_use"> = {
  main: "required", interactive: "main", embedding: "required", judge: "on_use",
};
const MODEL_ROLES = Object.keys(WHEN_NULL) as ModelRole[];
export const isRole = (v: string): v is ModelRole => v in WHEN_NULL;

/** The commented default config.jsonc; also the source of the defaults. */
export const DEFAULT_CONFIG_JSONC = Deno.readTextFileSync(new URL("./config.default.jsonc", import.meta.url));

/** Parse JSON with // and /* comments and trailing commas. */
export function parseJsonc(text: string): any {
  // Walks the text, copying strings verbatim and passing everything else to `other`.
  const scan = (src: string, other: (i: number) => [string, number]) => {
    let out = "";
    for (let i = 0; i < src.length; i++) {
      if (src[i] === '"') {
        const start = i;
        for (i++; i < src.length && src[i] !== '"'; i++) if (src[i] === "\\") i++;
        out += src.slice(start, i + 1);
      } else {
        const [s, next] = other(i);
        out += s;
        i = next;
      }
    }
    return out;
  };
  const noComments = scan(text, (i) => {
    if (text[i] === "/" && text[i + 1] === "/") {
      const end = text.indexOf("\n", i);
      return end < 0 ? ["", text.length] : ["\n", end];
    }
    if (text[i] === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2);
      if (end < 0) throw new SyntaxError("unterminated /* comment");
      return [text.slice(i, end + 2).replace(/[^\n]/g, " "), end + 1]; // keeps line numbers for errors
    }
    return [text[i], i];
  });
  const noTrailing = scan(noComments, (i) => [noComments[i] === "," && /^\s*[}\]]/.test(noComments.slice(i + 1)) ? "" : noComments[i], i]);
  return JSON.parse(noTrailing);
}

interface Settings {
  owner: { name: string; timezone: string };
  db_path: string;
  workspace: string;
  api: { host: string; port: number; token: string };
  web: { searxng: string };
  push: { subject: string; ttl_s: number };
  api_key: string;
  roles: Record<ModelRole, string | null>;
  models: Record<string, ModelConfig>;
}

export const config = {
  ...(parseJsonc(DEFAULT_CONFIG_JSONC) as Settings),
  capture: { segment_min_words: 12, quote_match_min: 0.9, unfiled_min_words: 8 },
  router: { recent_candidates: 6, fts_candidates: 3 },
  desk: { max_actions: 3, history_messages: 8 },
  needs_you: { max_question_words: 25, max_options: 4, max_option_words: 6 },
  board: { max_children: 5, max_attempts: 2, max_llm_calls_per_tree: 40, lease_seconds: 300 },
  worker_roles: {
    research: { steps: 10, tools: ["web_search", "web_fetch", "read_artifact"] },
    write: { steps: 6, tools: ["read_artifact", "write_artifact"] },
    synthesize: { steps: 6, tools: ["read_artifact", "write_artifact"] },
    code: { steps: 15, tools: ["list_dir", "read_file", "write_file", "run"] },
  } as Record<string, { steps: number; tools: string[] }>,
  tool_result_window: 2500,
  guards: { repetition_min_chars: 500, max_duplicate_calls: 2, whitespace_run_limit: 200 },
  memory: { volatility_max_age_days: { volatile: 7, slow: 180, evergreen: null as number | null }, top_k: 6 },
  notifier: {
    levels: {
      question: "push", reminder: "push", card_result: "badge", desk_reply: "badge", receipt: "silent", review: "silent", system: "badge",
    } as Record<string, string>,
    max_push_per_day: 6,
  },
};

const isObj = (v: unknown): v is Record<string, any> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Objects merge key by key; arrays and scalars replace. */
function merge(into: Record<string, any>, from: Record<string, any>) {
  for (const [k, v] of Object.entries(from)) {
    if (isObj(v) && isObj(into[k])) merge(into[k], v);
    else into[k] = v;
  }
}

/** Read config.jsonc over the defaults. Without one, write the commented default there and exit. */
export function loadConfig(path = "config.jsonc") {
  let text: string;
  try {
    text = Deno.readTextFileSync(path);
  } catch (e) {
    if (!(e instanceof Deno.errors.NotFound)) throw e;
    Deno.writeTextFileSync(path, DEFAULT_CONFIG_JSONC);
    console.log(`Wrote the default configuration to ${path}. Set your API key there (and anything else), then run again.`);
    Deno.exit(0);
  }
  let user: unknown;
  try {
    user = parseJsonc(text);
  } catch (e) {
    console.error(`${path}: ${(e as Error).message}`);
    Deno.exit(1);
  }
  if (!isObj(user)) {
    console.error(`${path}: expected an object at the top level`);
    Deno.exit(1);
  }
  if ("profiles" in user) {
    console.error(`${path}: "profiles" is replaced by "models" (endpoints by slug) and "roles" (which slug does what); see config.default.jsonc`);
    Deno.exit(1);
  }
  const known = Object.keys(parseJsonc(DEFAULT_CONFIG_JSONC));
  const unknown = Object.keys(user).filter((k) => !known.includes(k));
  if (unknown.length) console.warn(`${path}: ignoring unknown keys: ${unknown.join(", ")}`);
  for (const k of unknown) delete user[k];
  if (isObj(user.roles)) {
    const extra = Object.keys(user.roles).filter((k) => !isRole(k));
    if (extra.length) console.warn(`${path}: roles: ignoring unknown roles: ${extra.join(", ")} (known: ${MODEL_ROLES.join(", ")})`);
    for (const k of extra) delete user.roles[k];
  }
  for (const [slug, m] of Object.entries(isObj(user.models) ? user.models : {})) {
    const extra = isObj(m) ? Object.keys(m).filter((k) => !MODEL_KEYS.includes(k)) : [];
    if (extra.length) console.warn(`${path}: models.${slug}: ignoring unknown keys: ${extra.join(", ")}`);
    for (const k of extra) delete (m as Record<string, unknown>)[k];
  }
  merge(config, user);
  for (const m of Object.values(config.models)) {
    for (const [k, v] of Object.entries(MODEL_DEFAULTS)) (m as Record<string, any>)[k] ??= structuredClone(v);
    m.api_key ||= config.api_key;
  }
  const problems = checkRoles();
  if (problems.length) {
    for (const p of problems) console.error(`${path}: ${p}`);
    Deno.exit(1);
  }
}

/** Config errors in "roles" and the models they name. */
function checkRoles(): string[] {
  const out: string[] = [];
  for (const role of MODEL_ROLES) {
    const slug = config.roles[role];
    if (slug == null) {
      if (WHEN_NULL[role] === "required") out.push(`roles.${role} must name a model`);
      continue;
    }
    const m = config.models[slug];
    if (!isObj(m)) out.push(`roles.${role}: no model "${slug}" under "models"`);
    else if (!m.base_url || !m.model) out.push(`models.${slug}: needs "base_url" and "model"`);
  }
  return out;
}

/** The role a role runs as: itself, or the role it falls back to. Throws if neither is set up. */
export function modelRole(role: ModelRole): ModelRole {
  for (let r: string = role; isRole(r); r = WHEN_NULL[r]) {
    if (config.roles[r] != null) return r;
  }
  throw new Error(`no model for role "${role}": set roles.${role} in config.jsonc`);
}

/** The model slug a role runs on, after fallback. Throws if the role (and its fallback) is not set up. */
export function modelSlug(role: ModelRole): string {
  return config.roles[modelRole(role)]!;
}

/** The model a role runs on, after fallback. Throws if the role is not set up. */
export function modelFor(role: ModelRole): ModelConfig {
  return config.models[modelSlug(role)];
}

/** Worker roles (config.worker_roles), unrelated to model roles. */
export type Role = "research" | "write" | "synthesize" | "code";
