# Bench

Small, isolated cases per role plus a few whole pipelines. See [../docs/BENCH.md](../docs/BENCH.md)
for the design, results and findings.

```sh
deno task bench                          # the hard cases once
deno task bench --full                   # all cases once
deno task bench triage/ desk/ --repeat 3 # filter by id substring (within the hard or full set), pool 3 runs
deno task bench --label my-change        # names the results file
```

A case (`cases/*.ts`) has `run()` calling real harness code, then a mechanical `check()` and/or
`judge` criteria for the LLM judge. Each case gets a fresh in-memory database, the offline corpus
(`corpus/*.md`), a fixed clock and the owner profile from `lib.ts`.

The hard cases are the `HARD` list in `run.ts`: those that failed at least once in recent runs.
The others pass reliably, so a plain run skips them. Move a case in or out of `HARD` when a
`--full` run shows it started or stopped failing. Episodes stay out of `HARD` (they cost most): when
one fails, add the failing stage as a unit case from its trace and put that in `HARD` instead.

To add a case from a real trace: find the call in the observer UI, copy its situation into a
fixture, and assert on receipts or card state rather than on wording.
