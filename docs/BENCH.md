# Benchmark: does the v5 design work with a weak model?

The bench exists to improve the harness, not to pick a model. It runs `qwen/qwen3.6-35b-a3b`
(thinking off, via OpenRouter) through the real harness code: small cases per role, plus episodes
(whole pipelines = milestone acceptance tests). Results are checked in code where possible (receipts,
card states, due dates, quotes, tool calls); otherwise an LLM judge (`xiaomi/mimo-v2.6-pro`) checks
written criteria about text quality and honesty.

`deno task bench [filter…] [--full] [--repeat N] [--label name] [--min-pass PCT]`. A plain run takes the
`HARD` cases in `bench/run.ts` (about $0.0075); `--full` runs all ~136 cases (about $0.035 per repeat).
CI runs the hard set once on every PR (see the end). Traces go to `data/bench.db`: set `"db_path"` to it
and open `/observer`.

**Setup.** Each case gets a fresh in-memory database, a fixed clock (Tue 29 Sep 2026, 08:14 Zurich), an
owner profile, and the offline corpus (`bench/corpus/*.md`, fictional pages; one puts the key fact
past the first page window to test paging). Cases call production functions, so a change to a code
rule or prompt shows up in the score.

## Result

v1 78.6% → v9 97.2% (109 cases × 3); after the chat client 98.3% (121 × 3). Noise at 3 repeats is
about ±2 points. Every role works once the harness does its part; calls stay small (worker step
~870 tokens in / 120 out). The validator repairs ~3% of outputs (mostly overlong `analysis`, since
the engine ignores `maxLength`); no call failed outright.

Still failing: **planner/generate-trip** nearly always. Free-mode plans can't express "hotels in
the cities from step 1"; the fix is a sequential recipe (§5.6), not more prompt work.
**memory/relevance-trivial**, **triage/write-missing-info** and **triage/big-trip-plan** fail
about one run in five, and are borderline calls.

## What the bench changed in the harness

Each row was found in a trace, fixed, and confirmed by the next run. DEVIATIONS.md refers to these rows.

| # | Failure | Change |
|---|---|---|
| 1 | Mixed one-sentence captures filed as one item | Segment above 12 words, not 30 |
| 2 | Desk created the same card 3× | Don't re-offer a used intent; result text "handled, don't do it again" |
| 3 | Desk folded a reminder into a research card | Args call: "only the part that asks for research or writing" |
| 4 | Desk claimed a cancel it can't do | `cancel_card` intent with undo |
| 5 | Worker asked "which city?" / permission to page | Owner profile in context; block only when the owner must decide |
| 6 | Worker never paged a long page | Continue-hint also as a footer |
| 7 | "Not found" ended as `fail`, result lost | Not-found is a research result; the verifier decides |
| 8 | Triage asked "which 4 insurers?" | `missing_info` only if only the owner can know it |
| 9 | Triage flipped on "compare 3 kits" | `compare_count` field; code splits at ≥3 |
| 10 | plan_fill copied the request into `criteria` | Param example + code guard |
| 11 | Gather aimed for exactly 5 items, then blocked | Default 3, "fewer is fine"; empty items step fails verification |
| 12 | Prices stored as `slow` | Code: a money amount makes a claim `volatile` |
| 13 | Consolidator replaced a price with an unrelated fact | `update` only for the same detail (code guard) |
| 14 | match_subject missed renamed products | "Only needs to be about the same thing" + examples |
| 15 | Desk acted on other items of the memo | Desk sees only its item |
| 16 | Extra actions after answering a question | `desk_more` gate before any further action |
| 17 | Verifier believed "I saved the file" | Unrecorded claims did not happen |
| 18 | Provider ignores `anyOf`; tool name as action | Quirk repair in the gateway |
| 19 | Dependent parts split into topics (#19) | `segment_capture/v3`: split only where each part stands alone |
| 20 | Answer followed by extra card/add (#24) | `desk_more/v2`: named options instead of a negated yes/no |

## Lessons

- **Code rules beat wording** for anything countable (rows 9–13): the model is shown the rule but
  code enforces it.
- **Gate "is anything left?", never "is anything missing?"** Row 16 helped; a gate asking triage
  whether information is missing (v5) dropped triage from 96% to 85%, because it primed the model to
  find something missing. Reverted.
- **No negations in choices.** `desk_more` v1 ("is a request still NOT handled?") flipped its answer
  in 16 of 30 traces (#24). Named options fixed it: 40/40.
- **Short lists beat examples.** For #19, a three-line list of what stays together (background +
  request, a follow-up on a result, "it"/"why") took segment cases to 70/70; worked examples added
  nothing, and a one-line version got 94–97%.
- **Grow cases from live traces.** Rows 1 and 15 and the "hi gets no reply" bug came from the running
  server, not the bench; each became a case.
- **Test stages, keep episodes for `--full`** (#27). Episodes cost two thirds of a hard run. `HARD`
  holds the stage each episode failed at instead, built from its trace: gather blocked
  (`worker/research-gather-open`), a remembered answer not used (`librarian/answered-rephrased`),
  over-splitting (`segment/no-cross-talk-memo`), an extra card (`desk/episode-balcony-add`). Hard
  run $0.0113 → $0.0075. The composition (fan-out, waiting, confirmation, move/undo) is code.

## CI

`.github/workflows/bench.yml` runs the hard set once per PR with `--min-pass 75`. A PR fails if more
than 5 of 23 cases fail. The hard set is flaky on purpose: about 2 failures per run on average
(generate-trip nearly always one of them). Using per-case failure rates from all saved runs, P(>5
failures) ≈ 5%; at current rates it is lower. It catches a broad regression, not a single case; check
those with `--repeat 5`. The workflow needs the `OPENROUTER_API_KEY` repository secret.
