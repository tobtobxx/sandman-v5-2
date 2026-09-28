// sandman <command>
//   serve            run API, dispatcher and both web UIs
//   bench [filter]   run the benchmark (see bench/README.md)
//   probe [profile]  report engine quirks
//   lint             check all prompt schemas (reasoning key first)

import { DB, setDefaultDb } from "./db.ts";
import { config } from "./config.ts";

const [cmd, ...args] = Deno.args;

switch (cmd) {
  case "serve": {
    setDefaultDb(new DB(config.db_path));
    const { serve } = await import("./server.ts");
    await serve();
    break;
  }
  case "bench": {
    const { runBench } = await import("../bench/run.ts");
    await runBench(args);
    break;
  }
  case "probe": {
    setDefaultDb(new DB(":memory:"));
    const { probe } = await import("./llm/probe.ts");
    console.log("quirks:", await probe(args[0] ?? "small"));
    break;
  }
  case "lint": {
    const { lintAll } = await import("./prompts/index.ts");
    const problems = lintAll();
    console.log(problems.length ? problems.join("\n") : "all schemas ok");
    if (problems.length) Deno.exit(1);
    break;
  }
  default:
    console.log("usage: sandman serve | bench [filter] | probe [profile] | lint");
}
