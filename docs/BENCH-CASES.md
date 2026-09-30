# Adding a bench case

Usually from a failure seen in the observer UI or the client.

1. **Find the stage that failed.** Open the call in `/observer` and pick the smallest role that went
   wrong (segment, route, desk, triage, worker, …). Add a unit case for that stage, not an episode.
2. **Add it to `bench/cases/<role>.ts`.** Use the file's helper (`seg(...)`, `desk(...)`, …) and copy
   the situation from the trace: the input text, plus any topics, cards or notes it needs as
   fixtures (`bench/lib.ts`). Ids are `<role>/<short-name>`; put a one-line comment above saying where
   it came from.
3. **Check outcomes, not wording.** Prefer a mechanical `check()` on receipts, card states, item
   counts or keywords. Use `judge` criteria only for text quality or honesty.
4. **Mark it hard if it came from a failure.** Add the id to `HARD` in `bench/run.ts` with a comment
   (the source, and the failure count once measured, e.g. `// observer trace: …, 16/20`).
5. **Measure (optional).** `deno task bench <id> --repeat 10`. A case that never fails does not belong
   in `HARD`.

The clock is fixed (Tue 29 Sep 2026, 08:14 Zurich) and web pages come from `bench/corpus/*.md`, so
write inputs that make sense at that time and add a corpus page if a case needs one.
See [BENCH.md](BENCH.md) for design and results, [../bench/README.md](../bench/README.md) for commands.
