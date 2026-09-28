# Bench chat-v1 — 2026-09-28T22:35:29.612Z

Model: qwen/qwen3.6-35b-a3b (thinking off). Judge: xiaomi/mimo-v2.6-pro. Repeats: 3.
**357/363 passed (98.3%)** — 960 target calls, $0.1048 total incl. judge, 265s

| group | pass | rate | calls | cost $ |
|---|---|---|---|---|
| segment | 26/27 | 96% | 24 | 0.0027 |
| route | 48/48 | 100% | 57 | 0.0044 |
| desk | 64/66 | 97% | 213 | 0.0149 |
| triage | 27/27 | 100% | 27 | 0.0032 |
| planner | 18/21 | 86% | 21 | 0.0024 |
| worker | 39/39 | 100% | 124 | 0.0197 |
| verifier | 27/27 | 100% | 27 | 0.0018 |
| librarian | 15/15 | 100% | 33 | 0.0025 |
| memory | 36/36 | 100% | 48 | 0.0042 |
| answers | 27/27 | 100% | 21 | 0.0011 |
| episode | 30/30 | 100% | 365 | 0.0424 |

## Failures

- **desk/conversation-work-goes-to-topic** #3: receipts: answered,card_created
- **desk/status-from-context** #2: judge: "The reply says the comparison is still in progress or waiting, and mentions the open question about AquaLine's water use" — The reply says the comparison is running (in progress) and blocked on AquaLine data, but frames the open question as a choice between using a forum estimate or excluding them, not specifically about AquaLine's water use.
- **planner/generate-trip** #1: judge: "Each subtask can be done on its own, without needing the result of another subtask" — Subtasks 2 and 3 explicitly depend on the itinerary from subtask 1 (hotels for each night, train routes between cities in the plan), so they cannot be done independently.
- **planner/generate-trip** #2: judge: "Each subtask can be done on its own, without needing the result of another subtask" — Subtasks 2 and 3 explicitly depend on the route/cities from subtask 1 ("each night of the 10-day trip", "between the cities identified in the itinerary"). They cannot be done independently without subtask 1's output.
- **planner/generate-trip** #3: judge: "Each subtask can be done on its own, without needing the result of another subtask" — Subtasks 2 and 3 explicitly depend on the route/cities from subtask 1 ("between the key stops in the proposed itinerary", "in each city"). They cannot be done independently.
- **segment/one-long-subject** #3: 2 items, want 1: ["I think we should add compost and maybe some sand before planting the garlic in October","please look into how much compost three beds of 1.2 by 3 metres need"]
