# Bench i27-hard-x3-b — 2026-09-29T08:51:15.443Z

Model: qwen/qwen3.6-35b-a3b (thinking off). Judge: xiaomi/mimo-v2.6-pro. Set: hard (23 of 136 cases). Repeats: 3.
**67/69 passed (97.1%)** — 167 target calls, $0.0226 total incl. judge, 44s

| group | pass | rate | calls | cost $ |
|---|---|---|---|---|
| segment | 12/12 | 100% | 12 | 0.0013 |
| triage | 9/9 | 100% | 9 | 0.0011 |
| desk | 15/15 | 100% | 57 | 0.0042 |
| verifier | 6/6 | 100% | 6 | 0.0003 |
| librarian | 6/6 | 100% | 18 | 0.0013 |
| memory | 9/9 | 100% | 15 | 0.0013 |
| answers | 3/3 | 100% | 3 | 0.0003 |
| planner | 1/3 | 33% | 3 | 0.0011 |
| worker | 6/6 | 100% | 44 | 0.0098 |

## Failures

- **planner/generate-trip** #1: judge: "Each subtask can be done on its own, without needing the result of another subtask" — Subtask 3 depends on the itinerary from subtask 2 (which cities to book hotels in), and subtask 2 depends on subtask 1's regional suitability findings. They are not independent.
- **planner/generate-trip** #3: judge: "Each subtask can be done on its own, without needing the result of another subtask" — Subtask 3 requires hotels matching the daily itinerary from subtask 2, and subtask 2's activities depend on the route from subtask 1. These are sequential dependencies, not independent.
