# Bench i72-hard-x3 — 2026-09-29T20:02:56.246Z

Model: qwen/qwen3.6-35b-a3b (reasoning none). Judge: xiaomi/mimo-v2.6-pro. Set: hard (23 of 136 cases). Repeats: 3.
**65/69 passed (94.2%)** — 162 target calls, $0.0195 total incl. judge, 39s

| group | pass | rate | calls | cost $ |
|---|---|---|---|---|
| segment | 12/12 | 100% | 12 | 0.0014 |
| triage | 9/9 | 100% | 9 | 0.0012 |
| desk | 15/15 | 100% | 57 | 0.0042 |
| verifier | 6/6 | 100% | 6 | 0.0004 |
| librarian | 5/6 | 83% | 17 | 0.0012 |
| memory | 9/9 | 100% | 15 | 0.0013 |
| answers | 3/3 | 100% | 3 | 0.0001 |
| worker | 6/6 | 100% | 40 | 0.0066 |
| planner | 0/3 | 0% | 3 | 0.0011 |

## Time per call

Measured from getting a slot to the end of the stream (queueing excluded); output tokens include reasoning where the server reports it.

| profile | call type | calls | ok | p50 s | p90 s | tokens out |
|---|---|---|---|---|---|---|
| small | consolidate_fact | 6 | 6 | 1.7 | 2.7 | 72 |
| small | desk_args_add | 3 | 3 | 1.3 | 1.3 | 44 |
| small | desk_args_answer | 6 | 6 | 0.7 | 1.2 | 38 |
| small | desk_args_new_work | 3 | 3 | 1.6 | 2.1 | 121 |
| small | desk_intent | 15 | 15 | 1.0 | 1.8 | 44 |
| small | desk_more | 12 | 12 | 0.9 | 1.5 | 49 |
| small | desk_reply | 9 | 9 | 0.8 | 1.1 | 30 |
| small | extract_entities | 6 | 6 | 0.9 | 1.2 | 27 |
| small | librarian | 6 | 6 | 1.8 | 2.1 | 98 |
| small | match_answer | 9 | 9 | 1.0 | 1.6 | 48 |
| small | plan_generate | 3 | 3 | 1.9 | 2.7 | 393 |
| small | relevance_rubric | 9 | 9 | 0.6 | 1.8 | 71 |
| small | render_answer | 5 | 5 | 0.6 | 1.3 | 41 |
| small | route_item | 3 | 3 | 1.0 | 1.1 | 66 |
| small | segment_capture | 12 | 12 | 1.1 | 2.6 | 102 |
| small | triage | 9 | 9 | 1.0 | 1.8 | 99 |
| small | verify_criterion | 6 | 6 | 1.0 | 1.3 | 54 |
| small | worker_step | 40 | 40 | 0.7 | 1.5 | 100 |

## Failures

- **librarian/negative-note** #3: verdict proceed, want answered
- **planner/generate-trip** #1: judge: "Each subtask can be done on its own, without needing the result of another subtask" — Subtasks 2-4 depend on the cities/route chosen in subtask 1 ('the identified cities', 'the cities on the itinerary'). They cannot be done independently without task 1's output.
- **planner/generate-trip** #2: judge: "Each subtask can be done on its own, without needing the result of another subtask" — Subtasks 2 and 3 explicitly depend on the itinerary from subtask 1 (hotels 'for each night of the 10-day trip', trains 'between the cities in the itinerary'), so they cannot be done independently.
- **planner/generate-trip** #3: judge: "Each subtask can be done on its own, without needing the result of another subtask" — Subtasks 2 and 3 explicitly depend on the itinerary from subtask 1 (hotels for each night of the itinerary, trains between itinerary cities). They cannot be done independently without knowing the cities/dates.
