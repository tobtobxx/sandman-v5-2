// Configuration with defaults (DESIGN §17). Environment overrides for secrets and paths.
// A local .env file (KEY=VALUE lines) is read if present; it is gitignored.

function loadDotEnv() {
  try {
    const text = Deno.readTextFileSync(".env");
    for (const line of text.split("\n")) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (m && Deno.env.get(m[1]) === undefined) Deno.env.set(m[1], m[2].replace(/^["']|["']$/g, ""));
    }
  } catch { /* no .env */ }
}
loadDotEnv();

const env = (k: string, d = "") => Deno.env.get(k) ?? d;

export interface Profile {
  base_url: string;
  model: string;
  api_key: string;
  thinking: boolean;
  slots: number;
  temperature: number;
  idle_timeout_s: number;
  quirks: string[];
  // OpenRouter only: provider routing preferences
  provider?: Record<string, unknown>;
}

export const config = {
  owner: { name: env("SANDMAN_OWNER", "Alex"), timezone: env("SANDMAN_TZ", "Europe/Zurich") },
  db_path: env("SANDMAN_DB", "data/sandman.db"),
  workspace: env("SANDMAN_WORKSPACE", "data/workspace"),
  api: { port: Number(env("SANDMAN_PORT", "8700")) },
  web_backend: env("SANDMAN_WEB", "live") as "live" | "corpus",
  profiles: {
    small: {
      base_url: env("SANDMAN_BASE_URL", "https://openrouter.ai/api/v1"),
      model: env("SANDMAN_MODEL", "qwen/qwen3.6-35b-a3b"),
      api_key: env("OPENROUTER_API_KEY"),
      thinking: false,
      slots: Number(env("SANDMAN_SLOTS", "4")),
      temperature: 0.3,
      idle_timeout_s: 60,
      quirks: ["keys_alphabetical", "unbounded_whitespace", "ignores_maxLength"],
      provider: { require_parameters: true },
    } as Profile,
    judge: {
      base_url: "https://openrouter.ai/api/v1",
      model: env("SANDMAN_JUDGE_MODEL", "xiaomi/mimo-v2.6-pro"),
      api_key: env("OPENROUTER_API_KEY"),
      thinking: false,
      slots: 4,
      temperature: 0,
      idle_timeout_s: 90,
      quirks: [],
      provider: { require_parameters: true },
    } as Profile,
  } as Record<string, Profile>,
  capture: { segment_min_words: 30, quote_match_min: 0.9, unfiled_min_words: 8 },
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
      question: "push", reminder: "push", card_result: "badge", desk_reply: "badge", receipt: "silent", review: "silent",
    } as Record<string, string>,
    max_push_per_day: 6,
  },
};

export type Role = "research" | "write" | "synthesize" | "code";
