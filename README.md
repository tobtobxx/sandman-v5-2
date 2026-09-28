# Sandman v5 — prototype

A multi-agent harness for weak, slow models, built from [docs/DESIGN.md](docs/DESIGN.md) to find
out whether that design works with a small model (`qwen/qwen3.6-35b-a3b`, thinking off).
The harness makes the decisions; the model answers one narrow question per call.

**Status:** prototype. Benchmark: 97.2% of 327 case runs (109 cases × 3) pass.
See [docs/BENCH.md](docs/BENCH.md) for what the benchmark found and changed, and
[docs/DEVIATIONS.md](docs/DEVIATIONS.md) for where the prototype differs from the design.

## Run it

```sh
nix develop                     # or: install deno ≥ 2.2 yourself
echo 'OPENROUTER_API_KEY=sk-or-…' > .env
deno task serve                 # http://localhost:8700  (client)  ·  /observer (all internal state)
deno task bench                 # the benchmark; filters: deno task bench desk/ episode/ --repeat 3
deno task probe                 # which engine quirks apply
deno run -A src/main.ts lint    # every prompt schema: reasoning key sorts first
```

With Nix: `nix run` starts the server, `nix run .#bench` runs the benchmark.

| env | default | |
|---|---|---|
| `OPENROUTER_API_KEY` | — | also read from `.env` |
| `SANDMAN_MODEL` / `SANDMAN_BASE_URL` | qwen3.6-35b-a3b / OpenRouter | any OpenAI-compatible server (llama.cpp works) |
| `SANDMAN_JUDGE_MODEL` | xiaomi/mimo-v2.6-pro | bench judge only |
| `SANDMAN_DB` | `data/sandman.db` | `data/bench.db` holds the last bench run's traces |
| `SANDMAN_WEB` | `live` | `corpus` = offline pages from `bench/corpus/` |
| `SANDMAN_SEARXNG` | — | search backend for `live`; otherwise DuckDuckGo HTML (best effort) |
| `SANDMAN_OWNER`, `SANDMAN_TZ` | Alex, Europe/Zurich | |
| `SANDMAN_PORT`, `SANDMAN_SLOTS`, `SANDMAN_TOKEN`, `SANDMAN_BUDGET_USD` | 8700, 4, —, — | |

## The two UIs

- **Client** (`/`), chat-first: the home screen is one prompt. A message sent from home is split
  and filed: one item opens its topic, several items open a screen that lists the topics they went
  to, and small talk ("hi", "brief me in one sentence", "give me an overview") opens a conversation
  topic that can see all topics. Each topic is a chat history with receipts (undo), running cards,
  inline questions with option buttons, and results; typing in a topic goes straight to it. Needs
  you, Review, Board and Memory sit at the bottom of the topic sidebar. Live via SSE. The API it
  uses is in [docs/API.md](docs/API.md).
- **Observer** (`/observer`): overview (calls, tokens, cost by call type), every card with its
  contract, state timeline, comments, harness-recorded facts and artifacts; every session step by
  step (prompt, raw output, parsed action, tool result, dedupe/repair flags); every LLM call with
  correct/incorrect labels; captures (segmentation with quote-match scores → routing candidates →
  desk calls → receipts → confirmation); desk turns; memory and the fact queue; live events; raw
  tables.

## Layout

```
src/
  llm/          gateway (schema, repair, streaming guards, slots, tracing), schema subset + linter, probe
  prompts/      every prompt: work.ts, conversation.ts, memory.ts (short, plain, versioned)
  work/         board + state machine, preflight (librarian → triage → planner), worker, verifier,
                policy (retry/escalation), recipes, dispatcher
  conversation/ capture (segment, quotes, route), desk, receipts/undo, questions/needs-you,
                briefing, pages, topics, review, tidy, when (reminder times)
  memory/       facts, consolidator, retriever
  tools/        web (live + offline corpus), artifacts (paging)
  server.ts     unified API + SSE + static UIs
bench/          lib (fixtures, judge), run, cases/*.ts, corpus/*.md, results/
ui/             client.html, observer.html (no build step)
docs/           DESIGN.md, BENCH.md, DEVIATIONS.md, v4-research-prompt.md (the prompt style reference)
```

## Prompt style

Short and plain, like the v4 researcher prompt: say what the job is, what each option means, and
what to reply. Example (`worker_step`, research role, first lines):

```
Your role is the researcher.

You investigate a task to find reliable and factual information.
Use web_search to find pages and web_fetch to read them. Snippets are short; read a page before you rely on it.

Because others will only see your result, name your sources.
If something can't be found, finish and say so in the result instead of guessing.
If a detail is unclear, make a sensible assumption, say so in the result, and go on.
```
