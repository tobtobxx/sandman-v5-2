// Work-layer prompts: triage, planner, worker, verifier, librarian.
// Style rule: short, plain sentences. Say what the job is, what the options mean, and what to reply.

import { arr, nstr, obj, oneOf, Schema, str } from "../llm/schema.ts";

export interface P {
  prompt: string;
  schema: Schema;
  maxTokens: number;
  version: string;
}

export const lines = (xs: string[], empty = "(none)") => (xs.length ? xs.map((x) => `- ${x}`).join("\n") : empty);

export const TOOL_LINES: Record<string, string> = {
  web_search: "web_search(query): search the web; returns titles, links and snippets",
  web_fetch: "web_fetch(url): read a web page",
  read_artifact: "read_artifact(id, from_char): read a saved text, starting at a character position",
  write_artifact: "write_artifact(name, what): create a text file; you describe what to write, and it is written for you",
};

export const ROLE_LINES: Record<string, string> = {
  research: "research: find facts on the web and report them with sources",
  write: "write: write a text such as an email, letter, plan or summary",
};

// ---------------------------------------------------------------- triage
export function triage(c: { title: string; goal: string; done_when: string[]; steps: number; tools: string[]; recipes: string[] }): P {
  return {
    version: "triage/v1",
    maxTokens: 150,
    schema: obj({ analysis: str(300), fits: oneOf(["yes", "no"]), missing_info: nstr(200) }),
    prompt: `You decide whether a task can be done in ONE work session.

A session has at most ${c.steps} steps and these tools:
${lines(c.tools.map((t) => TOOL_LINES[t]))}

For context, these multi-step plans exist (you are NOT choosing one now):
${lines(c.recipes)}

Examples:
- "Find the opening hours of the Zurich botanical garden" → fits: yes
- "Compare 4 health insurers on price and coverage and recommend one" → fits: no
- "Book a table for my birthday" (no date or place given) → missing_info: "Which date and which restaurant or area?"

Task: ${c.title}
Goal: ${c.goal}
Done when:
${lines(c.done_when)}

Reply with:
- analysis: one or two sentences
- fits: yes or no
- missing_info: a short question for the owner ONLY if the task cannot start without it, else null`,
  };
}

// ---------------------------------------------------------------- planner
export function pickRecipe(c: { title: string; goal: string; recipes: { id: string; title: string; description: string }[] }): P {
  return {
    version: "pick_recipe/v1",
    maxTokens: 120,
    schema: obj({ analysis: str(300), recipe_id: oneOf([...c.recipes.map((r) => r.id), "none"]) }),
    prompt: `This task is too big for one work session. Choose a plan for it.

Plans:
${lines(c.recipes.map((r) => `${r.id}: ${r.title}. ${r.description}`))}
- none: no plan fits; the task will be split another way

Task: ${c.title}
Goal: ${c.goal}

Reply with analysis (one sentence), then recipe_id.`,
  };
}

export function planFill(c: { request: string; goal: string; params: Record<string, string> }): P {
  const keys = Object.keys(c.params).sort();
  const props: Record<string, Schema> = { analysis: str(300) };
  for (const k of keys) props[k] = k === "max_items" ? { type: "integer" } : str(200);
  return {
    version: "plan_fill/v1",
    maxTokens: 250,
    schema: obj(props),
    prompt: `Fill in the parameters of a plan for the owner's request.

Parameters:
${lines(keys.map((k) => `${k}: ${c.params[k]}`))}

Criteria must be quoted or closely paraphrased from the owner's request. Never invent criteria.

Owner's request: "${c.request}"
Goal: ${c.goal}

Reply with analysis (one sentence), then the parameters.`,
  };
}

export function planGenerate(c: { title: string; goal: string; done_when: string[] }): P {
  return {
    version: "plan_generate/v1",
    maxTokens: 600,
    schema: obj({
      analysis: str(300),
      subtasks: arr(obj({ done_when: arr(str(200), 3, 1), goal: str(400), role: oneOf(["research", "write"]), title: str(80) }), 5, 2),
    }),
    prompt: `Split a task into 2 to 5 subtasks. They run at the same time, so none may need another's result.
Afterwards, one final step combines their results; do not add a subtask for combining.

Roles:
${lines(Object.values(ROLE_LINES))}

For each subtask give title, goal, role and done_when. done_when is 1-3 checks of what the result contains,
e.g. "Names the price, or states that it is not available".

Task: ${c.title}
Goal: ${c.goal}
Done when:
${lines(c.done_when)}

Reply with analysis (one sentence), then subtasks.`,
  };
}

// ---------------------------------------------------------------- worker
export const PREAMBLE: Record<string, string> = {
  research: `Your role is the researcher.

You investigate a task to find reliable and factual information.
Use web_search to find pages and web_fetch to read them. Snippets are short; read a page before you rely on it.

Because others will only see your result, name your sources.
If something can't be found, say so in the result instead of guessing.`,
  write: `Your role is the writer.

You write the text the task asks for. Create it with write_artifact: give a file name and describe
what to write, and the text is written for you. Then finish with a short summary of what you wrote.`,
  synthesize: `Your role is the synthesizer.

Other sessions worked on parts of this task. Their results are below under Inputs.
Combine them into one answer for the owner. If the task asks for a recommendation, make one.
If the task asks for a document, create it with write_artifact.`,
};

const FACT_HELP = `facts: things you learned that a later task could reuse.
- subject: the thing the fact is about (a product, place, organization). Not a property like "Price".
- volatility: evergreen (never changes), slow (changes over months), volatile (prices, availability, news).`;

function factSchema() {
  return obj({ claim: str(300), source: str(300), subject: str(80), volatility: oneOf(["evergreen", "slow", "volatile"]) });
}

export function resultSchema(role: string, withItems: boolean): Schema {
  const facts = arr(factSchema(), 8);
  if (role === "research") {
    const p: Record<string, Schema> = { facts, open_questions: arr(str(200), 3), sources: arr(str(300), 8), summary: str(1500) };
    if (withItems) p.items = arr(obj({ name: str(80), note: str(200) }), 5);
    const sorted: Record<string, Schema> = {};
    for (const k of Object.keys(p).sort()) sorted[k] = p[k];
    return obj(sorted);
  }
  if (role === "synthesize") {
    return obj({ facts, open_questions: arr(str(200), 3), recommendation: nstr(600), summary: str(1500) });
  }
  return obj({ facts, summary: str(1000) });
}

function resultHelp(role: string, withItems: boolean) {
  const parts = [`summary: the answer, in a few sentences.`];
  if (role === "research") parts.push("sources: the links you used.", "open_questions: what you could not find out.");
  if (role === "synthesize") parts.push("recommendation: your recommendation, or null.", "open_questions: what is still unclear.");
  if (withItems) parts.push("items: the candidates you found, each with a name and one line why it fits.");
  parts.push(FACT_HELP);
  return parts.join("\n");
}

export function toolArgSchema(tool: string): Schema {
  switch (tool) {
    case "web_search":
      return obj({ query: str(200) });
    case "web_fetch":
      return obj({ url: str(500) });
    case "read_artifact":
      return obj({ from_char: { type: "integer" }, id: str(40) });
    case "write_artifact":
      return obj({ name: str(80), what: str(600) });
  }
  throw new Error(tool);
}

export function workerStep(c: {
  role: string;
  tools: string[];
  withItems: boolean;
  owner: string;
  title: string;
  goal: string;
  done_when: string[];
  constraints: string[];
  memory: string;
  inputs: string;
  comments: string[];
  steps: string[];
  step: number;
  maxSteps: number;
}): P {
  const last = c.step >= c.maxSteps;
  const tools = last ? [] : c.tools;
  const alts: Schema[] = tools.map((t) => obj({ action: { type: "string", const: "tool" }, tool: { type: "string", const: t }, tool_args: toolArgSchema(t) }));
  alts.push(obj({ action: { type: "string", const: "finish" }, result: resultSchema(c.role, c.withItems) }));
  alts.push(obj({ action: { type: "string", const: "block" }, analysis: str(300), question: str(200), question_options: arr(str(50), 4, 2) }));
  alts.push(obj({ action: { type: "string", const: "fail" }, analysis: str(300), category: oneOf(["impossible", "out_of_scope", "unclear", "tool_error"]) }));
  const actionLines = [
    ...(tools.length ? ["tool: use one of the tools."] : []),
    "finish: you are done. Give the result.",
    "block: you can't go on without the owner. Ask one short question (at most 25 words) with 2-4 short options.",
    "fail: the task can't be done.",
  ];
  const sec = (title: string, body: string) => (body.trim() ? `\n${title}:\n${body.trim()}\n` : "");
  return {
    version: "worker_step/v1",
    maxTokens: 1200,
    schema: { anyOf: alts },
    prompt: `${PREAMBLE[c.role]}
${tools.length ? `\nTools:\n${lines(tools.map((t) => TOOL_LINES[t]))}\n` : ""}
Actions:
${lines(actionLines)}

The result has these parts:
${resultHelp(c.role, c.withItems)}
${sec("About the owner", c.owner)}
Task: ${c.title}
Goal: ${c.goal}
Done when:
${lines(c.done_when)}
${c.constraints.length ? `Constraints:\n${lines(c.constraints)}\n` : ""}${sec("Known from memory", c.memory)}${sec("Inputs", c.inputs)}${
      sec("Comments", c.comments.map((x) => `- ${x}`).join("\n"))
    }${sec("Steps so far", c.steps.join("\n\n"))}
Step ${c.step} of ${c.maxSteps}. Choose exactly one action.${last ? " This is your final step." : ""}`,
  };
}

export function generateContent(c: { title: string; goal: string; inputs: string; memory: string; name: string; what: string }): P {
  return {
    version: "generate_content/v1",
    maxTokens: 2500,
    schema: {},
    prompt: `Write the file "${c.name}".

What to write: ${c.what}

It is part of this task: ${c.title}. ${c.goal}
${c.memory.trim() ? `\nKnown from memory:\n${c.memory.trim()}\n` : ""}${c.inputs.trim() ? `\nMaterial:\n${c.inputs.trim()}\n` : ""}
Reply with the file content only, nothing before or after it.`,
  };
}

// ---------------------------------------------------------------- verifier
export function verifyCriterion(c: { criterion: string; result: string; recorded: string; excerpts: string }): P {
  return {
    version: "verify_criterion/v1",
    maxTokens: 200,
    schema: obj({ analysis: str(300), verdict: oneOf(["pass", "fail"]) }),
    prompt: `Check ONE criterion against a work result. Judge only what is shown below.

Criterion: "${c.criterion}"

Result:
${c.result}

Recorded by the system (reliable):
${c.recorded || "(nothing)"}
${c.excerpts ? `\nFiles:\n${c.excerpts}\n` : ""}
Reply with analysis (at most 40 words), then verdict: pass or fail.`,
  };
}

// ---------------------------------------------------------------- librarian
export function extractEntities(c: { title: string; goal: string }): P {
  return {
    version: "extract_entities/v1",
    maxTokens: 80,
    schema: obj({ entities: arr(str(60), 6) }),
    prompt: `List the named things in this task: products, places, organizations, people, concepts. Short names only.

Task: ${c.title}
Goal: ${c.goal}

Reply with entities (at most 6).`,
  };
}

export function librarian(c: { goal: string; done_when: string[]; notes: string; answerable: string[] }): P {
  return {
    version: "librarian/v1",
    maxTokens: 250,
    schema: obj({
      analysis: str(300),
      answer_note_ids: arr(oneOf(c.answerable.length ? c.answerable : ["none"]), 6),
      narrowed_goal: nstr(400),
      verdict: oneOf(["answered", "narrow", "proceed"]),
    }),
    prompt: `Before work starts on a task, you check what is already known.

Verdicts:
- answered: the notes below fully answer the task. List the notes that answer it in answer_note_ids.
- narrow: the notes answer part of it. Write a smaller goal in narrowed_goal that only asks for what is missing or outdated.
- proceed: the notes don't help much. Work starts as planned.

Facts marked "may be outdated" can't answer the task; use narrow to check them again.

Task goal: ${c.goal}
Done when:
${lines(c.done_when)}

Notes:
${c.notes}

Reply with analysis (one or two sentences), then answer_note_ids, narrowed_goal (or null), verdict.`,
  };
}

export function renderAnswer(c: { goal: string; notes: string }): P {
  return {
    version: "render_answer/v1",
    maxTokens: 400,
    schema: obj({ summary: str(1500) }),
    prompt: `Answer the task from these notes only.

Task goal: ${c.goal}

Notes:
${c.notes}

Reply with summary: the answer in a few sentences, naming the notes' facts.`,
  };
}
