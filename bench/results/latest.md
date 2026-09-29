# Bench i71-prompts-full-x3 — 2026-09-29T21:46:43.663Z

Model: qwen/qwen3.6-35b-a3b (reasoning none). Judge: xiaomi/mimo-v2.6-pro. Set: full (143 of 143 cases). Repeats: 3.
**418/429 passed (97.4%)** — 1221 target calls, $0.1265 total incl. judge, 281s

| group | pass | rate | calls | cost $ |
|---|---|---|---|---|
| segment | 44/45 | 98% | 42 | 0.0044 |
| route | 57/57 | 100% | 69 | 0.0047 |
| desk | 68/69 | 99% | 213 | 0.0150 |
| triage | 27/27 | 100% | 28 | 0.0032 |
| planner | 18/21 | 86% | 21 | 0.0025 |
| worker | 45/45 | 100% | 177 | 0.0359 |
| verifier | 27/27 | 100% | 27 | 0.0016 |
| librarian | 18/21 | 86% | 92 | 0.0038 |
| memory | 39/39 | 100% | 75 | 0.0052 |
| search | 21/21 | 100% | 42 | 0.0000 |
| answers | 27/27 | 100% | 21 | 0.0010 |
| episode | 27/30 | 90% | 414 | 0.0435 |

## Time per call

Measured from getting a slot to the end of the stream (queueing excluded); output tokens include reasoning where the server reports it.

| profile | call type | calls | ok | p50 s | p90 s | tokens out |
|---|---|---|---|---|---|---|
| embedding | embed_document | 61 | 61 | 0.1 | 0.1 | 0 |
| embedding | embed_query | 79 | 79 | 0.1 | 0.1 | 0 |
| small | consolidate_fact | 20 | 20 | 1.2 | 4.1 | 72 |
| small | desk_args_add | 10 | 10 | 0.6 | 4.2 | 41 |
| small | desk_args_answer | 8 | 8 | 1.0 | 3.4 | 38 |
| small | desk_args_cancel | 3 | 3 | 0.4 | 0.8 | 24 |
| small | desk_args_new_work | 36 | 36 | 1.2 | 5.8 | 136 |
| small | desk_args_reminder | 22 | 22 | 0.4 | 1.6 | 25 |
| small | desk_intent | 103 | 103 | 0.9 | 2.0 | 44 |
| small | desk_more | 79 | 79 | 0.6 | 1.4 | 50 |
| small | desk_reply | 31 | 31 | 0.8 | 1.4 | 27 |
| small | extract_entities | 40 | 40 | 0.7 | 1.7 | 40 |
| small | extract_owner_facts | 6 | 6 | 1.0 | 8.8 | 69 |
| small | generate_content | 12 | 12 | 1.4 | 4.3 | 284 |
| small | librarian | 37 | 37 | 1.5 | 5.6 | 109 |
| small | match_answer | 21 | 21 | 1.0 | 1.9 | 44 |
| small | match_subject | 9 | 9 | 0.9 | 2.3 | 64 |
| small | pick_recipe | 18 | 18 | 0.7 | 2.4 | 66 |
| small | plan_fill | 12 | 12 | 0.7 | 2.9 | 75 |
| small | plan_generate | 3 | 3 | 7.3 | 14.6 | 409 |
| small | relevance_rubric | 35 | 35 | 1.2 | 1.9 | 74 |
| small | render_answer | 29 | 29 | 0.9 | 3.1 | 55 |
| small | resolve_when | 1 | 1 | 1.0 | 1.0 | 57 |
| small | route_item | 91 | 91 | 0.6 | 1.4 | 58 |
| small | segment_capture | 51 | 51 | 0.9 | 1.6 | 102 |
| small | topic_same | 6 | 6 | 1.2 | 1.4 | 38 |
| small | topic_title | 24 | 24 | 0.4 | 1.1 | 16 |
| small | triage | 41 | 40 | 1.1 | 2.8 | 90 |
| small | verify_criterion | 84 | 84 | 0.8 | 2.8 | 53 |
| small | worker_step | 249 | 249 | 0.8 | 3.1 | 152 |

## Failures

- **desk/conversation-answers-question** #1: receipts: added_to_card; answer null
- **episode/capture-no-cross-talk** #1: reminders: Check the drip kit for the two balcony pots, File the tax extension
- **episode/memory-reuse** #2: second: done, source worker; notes Alex (profile), Velostation Nord e-bike repair service; consolidation {"new":1}; 1 worker sessions
- **episode/recipe-tree** #3: children: gather:Find candidate drip irrigation kits:done | detail:Detail Gardena Micro-Drip starter set:done
- **librarian/narrow-stale-price** #2: verdict answered, want narrow; narrowed goal still asks everything: Find out whether Velostation Nord repairs e-bikes and what an e-bike service costs.
- **librarian/negative-note** #1: verdict narrow, want answered
- **librarian/negative-note** #3: verdict narrow, want answered
- **planner/generate-trip** #1: judge: "Each subtask can be done on its own, without needing the result of another subtask" — Subtask 2 requires travel logistics from previous regions, and subtask 3 references coverage from subtask 1, creating dependencies. Subtasks are not fully independent.
- **planner/generate-trip** #2: judge: "Each subtask can be done on its own, without needing the result of another subtask" — Subtasks 1-3 are largely independent, but subtask 4 explicitly states its purpose is to 'refine the daily schedule and hotel choices' from subtasks 1-2, creating a dependency. Also, subtask 1 overlaps with subtask 3 on train connections.
- **planner/generate-trip** #3: judge: "Each subtask can be done on its own, without needing the result of another subtask" — Subtasks 2 and 3 explicitly depend on the cities identified in subtask 1's route, so they cannot be done independently without its result.
- **segment/find-then-book-it** #1: 2 items, want 1: ["Look up which pizzeria near Hardbrücke has the best reviews.","If it's open on Sunday, reserve a table for four there."]
