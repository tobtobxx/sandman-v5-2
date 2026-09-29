# Deviations from DESIGN.md

This is a prototype built to test whether the design's model works with a weak model. Where it
differs from the design, the reason is below. Bench-driven changes reference docs/BENCH.md rows.

## Stack and scope

**Deno/TypeScript instead of Python/FastAPI (§3.2).** Owner request. SQLite via the built-in
`node:sqlite` (WAL, FTS5), no dependencies at all, so `flake.nix` only needs `deno`.

**Not implemented (prototype scope).** Speech-to-text and voice capture (the UI has a disabled
button), text-to-speech, Web Push (the notifier computes levels and the client uses browser
notifications while open), client tokens (one optional shared `api.token`), capture merging
within 10 s, the typing debounce, schedules/cron cards, projects and project briefs, recipe
promotion and `generalize_recipe`, `render_note`/`render_brief` (note one-liners are rendered in
code from claims), embeddings, the `code` role and its sandbox, the `large` escalation profile,
question nagging, quiet hours. `report_mode: desk` is not implemented; results are structured.

**Artifacts live in the database** (`artifacts.content`), not in `workspace/<card>/` files.
Simpler to inspect and to isolate per bench case.

**Live web search is best effort.** `web.backend: "live"` uses SearXNG if `web.searxng` is set,
else DuckDuckGo's HTML endpoint (form POST, throttled to one request per 6 s; a bot challenge is
reported as a tool error, not as "no results"). The bench always uses the offline corpus (§14.3).

**Shorter IDs.** `prefix_` + 12 base32 chars (time + random) instead of a 26-char ULID. They stay
unique and sortable, and cost fewer prompt tokens when the model has to choose one.

**Prompts are TypeScript functions** (`src/prompts/*.ts`) with a version string each, instead of
`prompts/<call_type>/vN.md` files. Conditional sections (tools only when applicable, open
questions only when present) are easier to keep correct that way. `sandman lint` builds every
prompt and checks its schema.

**Streaming** is implemented as in §11 (idle timeout, whitespace watchdog, no resend after a
timeout). Rate-limit and 5xx responses *before* generation starts are retried with backoff,
since nothing is running server-side then.

## Chat-first client (owner decision, after the first benchmark)

The design separates capture, organization and attention and has no chat window (§6.1): talking
happened only on topic pages, and nothing handled "hi" or "give me an overview" (a live test filed
"hi" into a new topic called "General Greeting" and answered nothing). The client is now chat-first
(API in docs/API.md):

- **Home is one prompt.** A message sent from home is segmented and routed as a capture. One item
  opens its topic; several items open a screen listing the topics they went to.
- **`chat` routing option.** `route_item` can choose `chat` for a greeting, small talk or a
  question about everything. That creates a **conversation topic** (`topics.kind = 'conversation'`,
  titled "Conversation 10:15"). The design's `reply_only`-without-a-topic outcome is gone.
- **Conversation topics see all topics.** Their desk context holds a code-built overview (every
  subject topic with its open cards and questions, results of the last day, pending reminders), all
  open cards and all open questions. `nothing` is not offered there, so Sandman always answers.
  Work or a reminder asked for in a conversation is routed into a subject topic (with a note there).
- **Topic pages are chat histories.** A message typed in a topic goes straight to that topic.
- **Sending is two steps.** `POST /send` segments and routes, then returns so the client can
  navigate at once; the desk turns run in the background and arrive as events.
- **Conversation topics are archived after one quiet day**, without a review notice, and never get
  merge suggestions. They are never routing candidates.

## Behaviour changed because of the benchmark

**Segmentation threshold 12 words, not 30 (§6.3, BENCH row 1).** The design's own M3 acceptance
capture ("garden: …, remind me Friday …, and find out if …") is one sentence of 26 words and was
never segmented under the 30-word rule.

**The desk does not see the full memo in capture mode (§6.3, §6.6, row 15).** With the full
transcript, the desk acted on other items' parts: it created the e-bike card in the garden topic
and gave the balcony remark a reminder with the tax item's "Friday". Without it, cross-talk
stopped. References like "that kit" across items are not resolved now; the topic context
(summary, cards, recent messages) covers most of them.

**Desk later passes are gated (§6.6, row 16).** Instead of offering `done` among the actions on
passes 2–3, a `desk_more` call asks "is a separate request still not handled? yes/no", and only
on yes are the (remaining) actions offered. An intent already executed in the turn is not offered
again.

**`cancel_card` desk intent (P4, row 4).** Missing from §6.6; without it the desk claimed
cancellations it couldn't do. Its receipt's undo re-creates the card from its contract (cancelled
is terminal).

**Triage has a `compare_count` field and a code rule (§5.5, §19 Q1, row 9).** Comparing ≥3 things
always splits. The key sorts before `fits`, so the count is produced before the decision.

**Research "not found" is a result (§5.10, row 7).** A research worker's `fail` other than
`out_of_scope` becomes a finished result ("Not found. …") that the verifier judges, plus a
negative fact. Not on item-gathering recipe steps, where the items matter (row 11). Research
workers are only offered `impossible | out_of_scope` as fail categories.

**Free-mode plans are research-only (§5.6).** `plan_generate` no longer offers a `write` role:
a write subtask in a parallel plan always depended on the research subtasks. The parent's
synthesis does the writing.

**Code guards (P1/P12).** plan_fill `criteria` must be short and not the request itself (row 10);
a claim with a money amount is `volatile` (row 12); `update`/`contradicts` in the consolidator
require the same detail (row 13); an items step with no items fails verification (row 11).

**Owner profile in triage and in generated content.** Triage asked "which city?" without it.
`generate_content` also gets today's date, to stop `[Date]` placeholders.

**Worker quirk repair (§10.2, row 18).** When an engine doesn't enforce `anyOf`, a tool name
written as the action is rewritten to a tool action before validation and logged as a repair.

## Smaller choices

- A reminder is a `reminder` card, as in §5.2. `when_text` is parsed in code (weekday names,
  "tomorrow at 3pm", "in two hours", dates); only when code fails, the model picks a date from a
  printed 21-day calendar (`resolve_when`) rather than doing date arithmetic.
- Topic summaries and owner-fact extraction run every 4 messages on a topic page, in the
  background.
- The needs-you ranking counts the blocked card plus its ancestors (children never have
  dependants other than their parent in v5).
- Consolidation runs when ≥20 facts are pending or once around 03:00, plus on demand; the tidy-up
  job runs after it.
