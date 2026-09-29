// Configuration (DESIGN §17). Settings a deployment changes live in config.jsonc, with defaults in
// config.default.jsonc; the rest are tuning defaults below. Without a config.jsonc, `loadConfig`
// writes the commented default and exits.

export interface Profile {
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
  quirks: string[];
}

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
  api: { port: number; token: string };
  web: { backend: "live" | "corpus"; searxng: string };
  budget_usd: number;
  api_key: string;
  profiles: Record<string, Profile>;
}

export const config = {
  ...(parseJsonc(DEFAULT_CONFIG_JSONC) as Settings),
  capture: { segment_min_words: 12, quote_match_min: 0.9, unfiled_min_words: 8 },
  router: { recent_candidates: 6, fts_candidates: 3 },
  desk: { max_actions: 3, history_messages: 8 },
  needs_you: { max_question_words: 25, max_options: 4, max_option_words: 6 },
  board: { max_children: 5, max_attempts: 2, max_llm_calls_per_tree: 40, lease_seconds: 300 },
  roles: {
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
  const known = Object.keys(parseJsonc(DEFAULT_CONFIG_JSONC));
  const unknown = Object.keys(user).filter((k) => !known.includes(k));
  if (unknown.length) console.warn(`${path}: ignoring unknown keys: ${unknown.join(", ")}`);
  for (const k of unknown) delete user[k];
  const profileKeys = Object.keys(parseJsonc(DEFAULT_CONFIG_JSONC).profiles.small);
  for (const [name, p] of Object.entries(isObj(user.profiles) ? user.profiles : {})) {
    const extra = isObj(p) ? Object.keys(p).filter((k) => !profileKeys.includes(k)) : [];
    if (extra.length) console.warn(`${path}: profile ${name}: ignoring unknown keys: ${extra.join(", ")}`);
  }
  merge(config, user);
  for (const p of Object.values(config.profiles)) p.api_key ||= config.api_key;
}

export type Role = "research" | "write" | "synthesize" | "code";
