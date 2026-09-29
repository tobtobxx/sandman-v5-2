# Benchmark: does the v5 design work with a weak model?

The bench exists to improve the harness, not to pick a model. It runs `qwen/qwen3.6-35b-a3b`
(thinking off, via OpenRouter) through the real harness code: small cases per role, plus episodes
(whole pipelines = milestone acceptance tests). Results are checked in code where possible (receipts,
card states, due dates, quotes, tool calls); otherwise an LLM judge (`xiaomi/mimo-v2.6-pro`) checks
written criteria about text quality and honesty.

`deno task bench [filter…] [--full] [--repeat N] [--label name] [--min-pass PCT]`. A plain run takes the
`HARD` cases in `bench/run.ts` (20 cases, about $0.007); `--full` runs all 144 cases (about $0.04 per repeat).
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
the cities from step 1"; the fix is a sequential recipe (§5.6, #77), not more prompt work.
**librarian/negative-note** fails about one run in four (#72; 3/10 on 29 Sep, before and after the
#72 changes). The rest fail now and then; `triage/big-trip-plan` stopped failing once its check accepted
`missing` (asking for dates first is defensible).

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
| 21 | Triage wrote "a letter about my claim" with placeholders instead of asking (#72) | `triage/v7`: the analysis also asks "does the result need anything only the owner knows?"; no "sensible assumption" clause. 5/20 → 20/20 |
| 22 | Prompts were long and put changing text early, so local engines re-read them on every call (#71) | Fixed text first, changing parts last, wording trimmed; front-desk prompts start with an identity line. Full ×10 against the branch base: 98.1% vs 97.6% (Fisher p=0.37), no case significantly worse; prompt tokens −4.3%, outside the cacheable prefix −6.9% (segment_capture −122, triage −82 per call) |

## Lessons

- **Trimming has a floor with this model** (#71). Every cut was A/B-tested against the old prompt.
  What broke: an identity line on every prompt ("You are part of Sandman, an autonomous swarm of
  agents": the librarian ignored "may be outdated" 12/20 vs 5/20, pick_recipe chose a plan for
  everything), so only the front desk has it now; shorter worker role texts (the synthesizer blocked
  instead of reporting a failed part, 7/10); "the owner" instead of the owner's name in desk_reply;
  dropping "the owner" from intent lines; any reword of the verifier, relevance rubric, match_subject
  and consolidate_fact; field rules above the task instead of after it (triage). Those keep their old
  text or order.
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

## Small classifier models (#32, not adopted)

Tried: moving the short classification calls (`route_item`, `match_answer`, `pick_recipe`, `topic_same`,
`topic_title`, `match_subject`, `relevance_rubric`, `consolidate_fact`) to a cheaper model. Measured on
the 41 cases that exercise them, × 2, one call at a time; the code for it was removed after the test.

| model | pass | time / call (p50) | output tokens |
|---|---|---|---|
| Qwen3.6-35B-A3B, OpenRouter, reasoning off | 100% | 1.1 s | 58 |
| Qwen3.6-35B-A3B, local llama.cpp (MXFP4), reasoning off | 98% | 13–48 s | 60 |
| LFM2.5-2.6B, OpenRouter (reasoning can't be turned off) | 95% w/o 429s | 13 s | 950 |
| LFM2.5-8B-A1B, local, reasoning (stopped after 39 runs) | 82% | ~100 s | – |
| MiniCPM5-1B, local, reasoning (budget 1000) | 50% | 44 s | 818 |
| MiniCPM5-1B, local, reasoning off | 48% | 3.7 s | 70 |

- **Quality:** the small models fail in the same places:
  - small talk ("hi", "brief me") routed to a new topic, and a named topic ("Garden: …") ignored;
  - `pick_recipe` never answers `none`;
  - paraphrased answers to a question not matched;
  - memory: a renamed product becomes a new note, and `relevance_rubric` answers contradict their own
    analysis ("not trivial" → `trivial: true`), so facts are discarded before consolidation.

  Reasoning barely helps (MiniCPM: +2 cases for 12× the time). Without reasoning, MiniCPM also overruns
  `max_tokens` with long analyses (invalid JSON).
- **Speed:** reasoning models spend 600–1000 tokens per call, so they are slower than Qwen without
  reasoning. Local Qwen's time grows with prompt length (~10 s + ~15 prompt tokens/s: `topic_title`
  13 s, `route_item` 48 s), so the local bottleneck is prompt processing (MoE prefill), not generation.
  Speed it up there (GPU offload, batch size) rather than with a second model.
- **Revisit** only with a model that passes these cases at ≥ 95% without reasoning. The lowest-risk calls
  to try first are `topic_title` (cosmetic) and `topic_same` (only suggests a merge for review).

## CI

`.github/workflows/bench.yml` runs the hard set once per PR with `--min-pass 90`: a PR fails if more
than 2 of 20 cases fail. Since #71 the hard set is exactly the cases that failed at least once in 20
full runs, so it is flaky on purpose: about 2 failures per run on unchanged code. By those per-case
rates the chance of a red run without any regression is 32% at `--min-pass 90`, 12% at 85, 3% at 80.
A red run is a prompt to look, not proof of a regression: re-run the failing cases with `--repeat 5`.
The workflow needs the `OPENROUTER_API_KEY` repository secret.
