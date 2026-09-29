# Bench i71-ab-tree-x10 — 2026-09-29T22:45:32.933Z

Model: qwen/qwen3.6-35b-a3b (reasoning none). Judge: xiaomi/mimo-v2.6-pro. Set: full (143 of 143 cases). Repeats: 10.
**1403/1430 passed (98.1%)** — 3982 target calls, $0.3793 total incl. judge, 794s

| group | pass | rate | calls | cost $ |
|---|---|---|---|---|
| segment | 146/150 | 97% | 140 | 0.0154 |
| route | 189/190 | 99% | 229 | 0.0154 |
| desk | 230/230 | 100% | 711 | 0.0494 |
| triage | 89/90 | 99% | 92 | 0.0101 |
| planner | 61/70 | 87% | 70 | 0.0091 |
| worker | 149/150 | 99% | 545 | 0.0903 |
| verifier | 90/90 | 100% | 90 | 0.0060 |
| librarian | 65/70 | 93% | 313 | 0.0129 |
| memory | 129/130 | 99% | 250 | 0.0163 |
| search | 70/70 | 100% | 140 | 0.0001 |
| answers | 90/90 | 100% | 70 | 0.0033 |
| episode | 95/100 | 95% | 1332 | 0.1312 |

## Time per call

Measured from getting a slot to the end of the stream (queueing excluded); output tokens include reasoning where the server reports it.

| profile | call type | calls | ok | p50 s | p90 s | tokens out |
|---|---|---|---|---|---|---|
| embedding | embed_document | 202 | 202 | 0.1 | 0.1 | 0 |
| embedding | embed_query | 256 | 256 | 0.1 | 0.1 | 0 |
| small | consolidate_fact | 59 | 59 | 1.1 | 2.4 | 75 |
| small | desk_args_add | 30 | 30 | 0.8 | 1.7 | 42 |
| small | desk_args_answer | 30 | 30 | 0.8 | 2.5 | 37 |
| small | desk_args_cancel | 10 | 10 | 0.7 | 10.4 | 24 |
| small | desk_args_new_work | 120 | 120 | 1.1 | 3.4 | 143 |
| small | desk_args_reminder | 70 | 70 | 0.5 | 1.3 | 25 |
| small | desk_intent | 341 | 341 | 0.6 | 1.5 | 44 |
| small | desk_more | 260 | 260 | 0.6 | 1.6 | 50 |
| small | desk_reply | 103 | 103 | 0.7 | 1.3 | 28 |
| small | extract_entities | 133 | 133 | 0.7 | 1.5 | 32 |
| small | extract_owner_facts | 20 | 20 | 1.3 | 2.2 | 69 |
| small | generate_content | 30 | 30 | 1.9 | 3.6 | 151 |
| small | librarian | 123 | 123 | 1.5 | 3.1 | 105 |
| small | match_answer | 74 | 74 | 0.9 | 1.9 | 44 |
| small | match_subject | 30 | 30 | 0.9 | 2.2 | 62 |
| small | pick_recipe | 59 | 59 | 0.8 | 2.3 | 64 |
| small | plan_fill | 39 | 39 | 1.0 | 2.6 | 71 |
| small | plan_generate | 10 | 10 | 5.3 | 12.6 | 446 |
| small | relevance_rubric | 108 | 108 | 0.9 | 2.0 | 74 |
| small | render_answer | 105 | 105 | 0.9 | 1.8 | 53 |
| small | route_item | 303 | 302 | 0.5 | 1.4 | 59 |
| small | segment_capture | 170 | 170 | 0.8 | 1.7 | 102 |
| small | topic_same | 20 | 20 | 0.8 | 2.2 | 41 |
| small | topic_title | 73 | 73 | 0.6 | 1.0 | 15 |
| small | triage | 134 | 132 | 0.7 | 1.5 | 90 |
| small | verify_criterion | 280 | 280 | 1.0 | 2.2 | 55 |
| small | worker_step | 790 | 790 | 0.9 | 2.6 | 122 |

## Failures

- **episode/capture-no-cross-talk** #7: 2 items: the drip kit also needs to reach the two balcony pots. | remind me Friday to file the tax extension, and find out if Velostation Nord repairs e-bikes and what a service costs
- **episode/compare-card** #4: state blocked; result: undefined
- **episode/memory-reuse** #3: second: done, source worker; notes Alex (profile); consolidation {}; 1 worker sessions
- **episode/memory-reuse** #10: second: done, source worker; notes Alex (profile), Velostation Nord; consolidation {"new":2}; 1 worker sessions
- **episode/research-card** #2: summary: Velostation Nord states they repair 'all common types of bicycles' (city, road, mountain, children's, cargo), but they do not explicitly mention e-bike repair. Consequently, no price for e-bike service is available.
- **librarian/narrow-stale-price** #1: verdict answered, want narrow; narrowed goal still asks everything: Find out whether Velostation Nord repairs e-bikes and what an e-bike service costs.
- **librarian/narrow-stale-price** #5: verdict answered, want narrow; narrowed goal still asks everything: Find out whether Velostation Nord repairs e-bikes and what an e-bike service costs.
- **librarian/narrow-stale-price** #9: verdict answered, want narrow; narrowed goal still asks everything: Find out whether Velostation Nord repairs e-bikes and what an e-bike service costs.
- **librarian/narrow-stale-price** #10: verdict answered, want narrow; narrowed goal still asks everything: Find out whether Velostation Nord repairs e-bikes and what an e-bike service costs.
- **librarian/negative-note** #8: verdict proceed, want answered
- **memory/subject-same-kind-different-thing** #8: matched existing note "Gardena Micro-Drip starter set"
- **planner/fill-choose-among** #6: criteria: quiet
- **planner/generate-trip** #1: judge: "Each subtask can be done on its own, without needing the result of another subtask" — Subtasks 1-3 are independent research tasks. Subtask 4 (itinerary) logically depends on results of 1-3 (regions, hotels, routes) to build a coherent plan, though it could be done standalone. A reasonable reader would see dependency.
- **planner/generate-trip** #2: judge: "Each subtask can be done on its own, without needing the result of another subtask" — Subtasks 2 and 3 explicitly depend on the itinerary from subtask 1 (hotels per night in assigned cities, trains between itinerary cities). They cannot be done independently without its result.
- **planner/generate-trip** #3: judge: "Each subtask can be done on its own, without needing the result of another subtask" — Subtasks 2-4 explicitly depend on the route/cities from subtask 1 ("proposed route", "selected cities", "each city on the route"). They cannot be done independently without that result.
- **planner/generate-trip** #5: judge: "Each subtask can be done on its own, without needing the result of another subtask" — Subtasks 2 and 3 explicitly depend on results of subtask 1 (hotels 'for each night' aligned to itinerary regions; trains 'between the cities selected for the itinerary'). They cannot be done independently.
- **planner/generate-trip** #6: judge: "Each subtask can be done on its own, without needing the result of another subtask" — Subtasks 2 and 3 explicitly depend on the itinerary from subtask 1 ("each night of the 10-day trip", "between the cities visited in the 10-day plan"), so they cannot be done independently.
- **planner/generate-trip** #7: judge: "Each subtask can be done on its own, without needing the result of another subtask" — Subtasks 2 and 3 explicitly depend on the itinerary stops from subtask 1 ('key stops identified in the itinerary'), violating independence.
- **planner/generate-trip** #9: judge: "Each subtask can be done on its own, without needing the result of another subtask" — Subtask 4 explicitly depends on results from subtasks 1 and 2 (weather and transport data), violating independence. Subtasks 1-3 are independent, but the criterion requires each subtask to be doable on its own.
- **planner/generate-trip** #10: judge: "Each subtask can be done on its own, without needing the result of another subtask" — Subtasks 2 and 3 explicitly depend on the itinerary from subtask 1 ("each night of the trip", "cities visited in the itinerary"), so they cannot be done independently.
- **route/new-subject** #8: routed to kitchen-renovation (Kitchen renovation), want new
- **segment/find-then-book-it** #9: 2 items, want 1: ["Look up which pizzeria near Hardbrücke has the best reviews.","If it's open on Sunday, reserve a table for four there."]
- **segment/no-cross-talk-memo** #3: 2 items, want 3: ["the drip kit also needs to reach the two balcony pots.","remind me Friday to file the tax extension, and find out if Velostation Nord repairs e-bikes and what a service costs"]
- **segment/one-long-subject** #4: 2 items, want 1: ["The soil seems very compact and I think we should add compost and maybe some sand before planting the garlic in October","please look into how much compost three beds of 1.2 by 3 metres need."]
- **segment/one-long-subject** #8: 2 items, want 1: ["The soil seems very compact and I think we should add compost and maybe some sand before planting the garlic in October","please look into how much compost three beds of 1.2 by 3 metres need."]
- **triage/write-enough-info** #5: got missing ("What is Mr. Keller's email address and what is the specific address or apartment number for the rental?"), want yes. The task is a single, focused action (drafting one email) that fits within the 6-step limit. No specific details like the landlord's email address or the exact apartment number are provided, which are necessary to finalize the email.
- **worker/research-gather-named** #5: 0 facts
