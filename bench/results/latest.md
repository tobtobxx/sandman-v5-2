# Bench v3 — 2026-09-28T20:16:54.950Z

Model: qwen/qwen3.6-35b-a3b (thinking off). Judge: xiaomi/mimo-v2.6-pro. Repeats: 2.
**198/210 passed (94.3%)** — 574 target calls, $0.0693 total incl. judge, 142s

| group | pass | rate | calls | cost $ |
|---|---|---|---|---|
| segment | 16/16 | 100% | 14 | 0.0017 |
| route | 20/20 | 100% | 26 | 0.0019 |
| desk | 31/32 | 97% | 101 | 0.0075 |
| triage | 17/18 | 94% | 18 | 0.0021 |
| planner | 12/14 | 86% | 14 | 0.0019 |
| worker | 22/26 | 85% | 82 | 0.0132 |
| verifier | 18/18 | 100% | 18 | 0.0011 |
| librarian | 10/10 | 100% | 22 | 0.0016 |
| memory | 20/22 | 91% | 28 | 0.0024 |
| answers | 18/18 | 100% | 14 | 0.0007 |
| episode | 14/16 | 88% | 237 | 0.0318 |

## Failures

- **desk/status-from-context** #1: receipts: answered,card_created; intent answer_question,new_work,done
- **episode/compare-card** #1: state waiting; result: undefined
- **episode/recipe-tree** #2: state waiting; recommendation: undefined
- **memory/relevance-reusable-price** #1: keep=false: {"analysis":"The source URL is completely irrelevant to the subject, indicating a hallucinated or mismatched fact rather than a verifiable piece of information about Velostation Nord.","costly":false,"reusable":false,"task_mechanics":false,"trivial":false}
- **memory/relevance-reusable-price** #2: keep=false: {"analysis":"The provided source link is irrelevant to the subject of Velostation Nord and the specific pricing claim, rendering the fact unsupported and likely false.","costly":false,"reusable":false,"task_mechanics":false,"trivial":false}
- **planner/generate-trip** #1: judge: "Each subtask can be done on its own, without needing the result of another subtask" — Subtasks 1-3 are independent. Subtask 4 explicitly depends on 'major hubs identified in the other subtasks,' requiring their results.
- **planner/generate-trip** #2: judge: "Each subtask can be done on its own, without needing the result of another subtask" — Subtasks 2 and 3 explicitly depend on the itinerary from subtask 1 ("cities identified in the itinerary", "cities in the proposed itinerary"), so they cannot be done independently.
- **triage/write-missing-info** #2: got yes, want missing. The task requires researching insurance claim facts and then writing the letter, which aligns with the 'Research the facts, then write the text' plan. It is a single output generation task, not a comparison of multiple options.
- **worker/research-facts-subject-rule** #1: price volatility slow
- **worker/research-facts-subject-rule** #2: price volatility slow
- **worker/research-not-available-honest** #2: outcome block
- **worker/write-email** #1: judge: "Contains no placeholders like [Your Name] or [Date]" — The output ends with a literal placeholder [Date], which directly violates the criterion.
