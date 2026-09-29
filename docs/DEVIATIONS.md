# Deviations from DESIGN.md

This is a prototype built to test whether the design works with a weak model. Where it differs
from the design, the reason is below. Bench-driven changes reference docs/BENCH.md rows.

## Stack and scope

**Deno/TypeScript instead of Python/FastAPI (§3.2).** Owner request. SQLite via the built-in
`node:sqlite` (WAL, FTS5), no dependencies, so `flake.nix` only needs `deno`.

**Not implemented yet** (tracked as `enhancement` issues): speech-to-text (#41), text-to-speech
(#42), Web Push (#43), per-client tokens (one shared `api.token`, #44), capture merging (#45),
typing debounce (#46), projects and briefs (#47), recipe promotion (#48), quiet hours (#49), a
reserved interactive slot (priorities only, #50), message paging, unread counts and approval
questions (#51), claim editing in the memory browser (#40), `report_mode: desk` (#58).

**Left out on purpose.**
- `render_note` / `render_brief`: a note's one-liner and body are built in code from its claims.
- `summarize_artifact`: an artifact's summary is the `what` of the write, or the page title.
- No per-call golden sets or `sandman eval`: the benchmark (docs/BENCH.md) is the eval suite;
  the observer's correct/incorrect labels are the only "add to eval set".
- Moving an item records no routing example; a move to a new topic titles it from the quote.
- Undoing a "new card" receipt always cancels the card, never deletes it.
- No `rebuild_memory`, purge or episodic FTS log. Retracted claims stay in the table.
- No secret redaction in traces: secrets live only in `config.jsonc` and never enter prompts.

**Artifacts live in the database** (`artifacts.content`), not in `workspace/<card>/` files, so
they are easy to inspect and to isolate per bench case. Only the `code` role works in files.

**Live web search is best effort.** SearXNG if `web.searxng` is set, else DuckDuckGo's HTML
endpoint (one request per 6 s; a bot challenge is a tool error). The bench uses the offline corpus.

**Shorter IDs.** `prefix_` + 12 base32 chars (time + random) instead of a 26-char ULID: unique,
sortable, and fewer prompt tokens when the model has to choose one.

**Prompts are TypeScript functions** (`src/prompts/*.ts`) with a version string each, instead of
`prompts/<call_type>/vN.md`. Conditional sections are easier to keep correct; `sandman lint` checks
every schema.

**Cheaper classifier profile.** Some pure classification calls may run on a separate, cheaper
profile (#32); the bench decides which.

## Chat-first client (owner decision, after the first benchmark)

The design has no chat window (§6.1), and nothing handled "hi" or "give me an overview" (a live test
filed "hi" into a new topic "General Greeting"). The client is chat-first (API in docs/API.md):

- **Home is one prompt.** A message from home is segmented and routed as a capture. One item opens
  its topic; several open a screen listing the topics they went to.
- **`chat` routing option.** `route_item` can choose `chat` for small talk or a question about
  everything. That creates a **conversation topic** ("Conversation 10:15"); `reply_only` without a
  topic is gone. Its desk context holds a code-built overview of all topics, open cards and
  questions; `nothing` is not offered there. Work asked for there is routed into a subject topic.
- **Topic pages are chat histories**; a message typed in a topic goes straight to it.
- **Sending is two steps.** `POST /send` segments and routes, then returns; desk turns run in the
  background and arrive as events.
- **Conversation topics are archived after one quiet day**, silently, and never get merge
  suggestions or routing candidacy.

## Behaviour changed because of the benchmark

- **Segmentation threshold 12 words, not 30 (§6.3, row 1).** The design's own M3 capture is one
  26-word sentence and was never segmented.
- **The desk doesn't see the full memo in capture mode (§6.6, row 15).** It acted on other items'
  parts. References like "that kit" across items are now resolved only via topic context.
- **Desk later passes are gated (row 16).** `desk_more` asks `nothing | another_request` (a yes/no
  version flipped, #24) before offering actions again; executed intents aren't offered again.
- **`cancel_card` desk intent (P4, row 4).** Without it the desk claimed cancellations. Undo
  re-creates the card from its contract.
- **Triage `compare_count` + code rule (§5.5, §19 Q1, row 9).** Comparing ≥3 things always splits.
- **Research "not found" is a result (§5.10, row 7)**, judged by the verifier, plus a negative
  fact; not on item-gathering steps (row 11). Research may only fail `impossible | out_of_scope`.
- **Free-mode plans are research-only (§5.6).** A `write` subtask always depended on the others;
  the parent's synthesis writes.
- **Code guards (P1/P12).** Short, non-verbatim plan criteria (row 10); money claims are `volatile`
  (row 12); `update`/`contradicts` need the same detail (row 13); an items step with no items fails
  verification (row 11).
- **Owner profile in triage and content**, plus today's date in `generate_content`.
- **Worker quirk repair (§10.2, row 18).** A tool name written as the action is rewritten to a tool
  action before validation and logged.

## Smaller choices

- Reminders are `reminder` cards. `when_text` is parsed in code; only if that fails, the model picks
  a date from a printed 21-day calendar (`resolve_when`) instead of doing date arithmetic.
- Topic summaries and owner-fact extraction run every 4 messages, in the background.
- Needs-you ranking counts the blocked card plus its ancestors (children have no other dependants).
- Consolidation runs at ≥20 pending facts or around 03:00, plus on demand; tidy-up runs after it.
