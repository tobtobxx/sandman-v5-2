// sandman <command> [--config path]   (default ./config.jsonc; written with defaults on first run)
//   serve [--db path]  run API, dispatcher and both web UIs
//   bench [--full] [filter]   run the benchmark (see bench/README.md)
//   probe [profile]  report engine quirks
//   lint             check all prompt schemas (reasoning key first)

import { DB, setDefaultDb } from "./db.ts";
import { config, loadConfig } from "./config.ts";

const [cmd, ...args] = Deno.args;
/** Removes `--name value` from args and returns the value. */
function flag(name: string): string | undefined {
  const i = args.indexOf(name);
  if (i < 0) return undefined;
  const [, v] = args.splice(i, 2);
  if (v === undefined) {
    console.error(`${name} needs a value`);
    Deno.exit(1);
  }
  return v;
}
const configPath = flag("--config") ?? "config.jsonc";
if (cmd === "serve" || cmd === "bench" || cmd === "probe") loadConfig(configPath);

switch (cmd) {
  case "serve": {
    config.db_path = flag("--db") ?? config.db_path;
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
    console.log("usage: sandman serve [--db path] | bench [--full] [filter] | probe [profile] | lint   [--config path]");
}
