# Bench

Small, isolated cases per role plus a few whole pipelines. See [../docs/BENCH.md](../docs/BENCH.md)
for the design, results and findings.

```sh
deno task bench                          # all cases once
deno task bench triage/ desk/ --repeat 3 # filter by id substring, pool 3 runs
deno task bench --label my-change        # names the results file
```

A case (`cases/*.ts`) has `run()` calling real harness code, then a mechanical `check()` and/or
`judge` criteria for the LLM judge. Each case gets a fresh in-memory database, the offline corpus
(`corpus/*.md`), a fixed clock and the owner profile from `lib.ts`.

To add a case from a real trace: find the call in the observer UI, copy its situation into a
fixture, and assert on receipts or card state rather than on wording.
