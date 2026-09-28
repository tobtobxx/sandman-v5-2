# Sandman v5 — Design Document

**A multi-agent harness for weak, slow local models**

| | |
|---|---|
| Status | Design for implementation |
| Date | 2026-09-28 |
| Project | Sandman v5. Figures marked **Measured** come from a 173-task benchmark run through the harness with qwen3.6-35b-a3b (thinking off) via OpenRouter. |
| Inspiration | Hermes Agent (Nous Research), in particular its Kanban multi-agent board |
| Target models | Small or mid-size open models, heavily quantized (Q3/Q4), served locally via an OpenAI-compatible server (llama.cpp preferred). Assume: slow generation (a few to ~30 tokens/s), prompt processing of a few hundred tokens/s, unreliable at long-horizon planning, unreliable at free-form JSON, good at short classification and summarization. |
| Interface | Sandman exposes one **unified API** (HTTP + event stream). A custom web UI and local applications are its clients. The owner **captures** without choosing anything (voice or text); Sandman splits, files and acts, and asks only through one needs-you list. |

---

## 0. How to use this document (for the implementing agent)

- **Normative** where it says MUST / MUST NOT, **advisory** where it says SHOULD / MAY. "Suggested" means a default you may replace with an equivalent.
- Every major decision is followed by a **Why** block. The reason is the requirement; the mechanism is negotiable. Blocks marked **Measured** report benchmark results.
- When ambiguous, prefer the option that (a) keeps control flow in code, (b) asks the model a smaller question, and (c) records facts in the harness rather than asking the model to report them.
- Record every deviation in `docs/DEVIATIONS.md` with a one-paragraph justification.

---

## 1. Problem statement

We want a personal, always-on agent system that:

1. Lets its owner tell it things without choosing anything first (e.g. a voice memo while driving), organizes what it hears into topics automatically (correctable by hand), and can **initiate** messages: results, questions, reminders.
2. Breaks work into small, bounded units executed by independent sessions, coordinated through a **Kanban board**.
3. Accumulates **long-term memory** from everything it learns, so future work benefits without the model having to know what to ask for.
4. Works acceptably with **weak, slow models**. This is the dominant constraint.

### 1.1 Goals

- G1. The owner can capture anything (voice or text, several subjects at once) without choosing a topic or channel. Sandman splits it, files each part into a topic and acts; the owner corrects filings by exception.
- G1b. Everything that needs the owner is in one ranked list, answerable by voice.
- G2. Work larger than one short session is decomposed into cards; each card runs in a fresh session with a narrow scope, a small toolset and a defined end.
- G3. Results, questions and reminders appear in the right topic, on every client, with an appropriate notification level. The model never decides delivery.
- G4. Knowledge produced by any card becomes available to future cards automatically, with provenance and freshness.
- G5. A wrong model output costs a retry, not a corrupted state. Nothing the model *claims* is trusted where the harness can observe the truth.
- G6. Everything is inspectable: board, topics, memory, sessions, tool calls and every LLM call.

### 1.2 Scope (v5)

- **Clients:** the owner's web UI, phone app and CLI, all talking to the unified API. Other front ends can be added later as API clients (§6.13).
- **Users:** one owner; the data model leaves room for more.
- **Deployment:** a single host with a single SQLite database.
- **Media:** text and voice. Voice is transcribed on the host; speech output is produced by clients. Attachments are stored as artifacts and referenced.

---

## 2. Design principles

### P1. The harness is the brain; the model is a function

All control flow (what runs next, when work is done, where a message goes, what gets remembered) is decided by code. The model is called with a narrow input and a constrained output.

> **Why:** weak models are bad at remembering to do things across turns and at tracking state. Anything the model must *remember to do* will eventually be skipped. Anything it is *asked* at the right moment, as a narrow question, it usually gets right.
>
> **Measured:** routing, triage, librarian, verifier and consolidator decisions reach 90–100% accuracy with a mid-size model, thinking off. Larger models did not score higher.

### P2. One decision per call; choose rather than generate; gate before you ask

Each call answers one question, preferably by choosing among enumerated options. A follow-up decision is asked **only after** the gating answer that makes it relevant.

> **Why:** small models are far more consistent at classification than generation. And if a call offers a choice that only makes sense under some condition, the model tends to make that choice regardless of the condition.
>
> **Measured:** with this gating ("fits?" first, "which recipe?" only after "no"), triage reached 90%.

### P3. Constrained decoding is necessary, not sufficient

Every output the harness parses MUST be produced under a JSON schema or grammar, and additionally:

- Every call sets `max_tokens`. The gateway validates locally, **truncates** over-long strings instead of failing, and fills missing optional keys with defaults.
- **Field order is part of the schema design.** Reasoning comes before the decision it justifies. Because some engines emit keys alphabetically, the reasoning key MUST sort alphabetically before every decision key (convention: `analysis`).
- **Long free text is produced by a separate plain-text call.** File bodies, reports, emails and replies come from that call; the JSON action only names and describes the content (`write_artifact(name, what)`).
- Each model profile has a **known-quirks list** (e.g. "keys alphabetical", "needs compact-JSON hint", "unbounded whitespace after `{`") and the benchmark is rerun per engine.

> **Why:** grammar engines differ. Beyond producing valid JSON, they vary in key order, whitespace handling, enforcement of `maxLength` and required keys, and escaping of newlines inside strings.
>
> **Measured:** with the reasoning key first, per-criterion verification reached 100%. Most engines tested lose `\n` inside JSON strings, which is why long text is generated as plain text.

### P4. Tools are actions; information is context

- A tool that only **reads** state the harness already has is not a tool; put that information in the context.
- A tool is offered **only when it can apply** (e.g. `answer_question` only when a question is open).
- **Every owner intent the front desk can meet has a tool.** A missing tool produces a confident lie ("I've updated the card").
- Each role gets only the tools its job needs.
- Every tool and every enum value (roles, intents) gets a one-line description in the prompt.
- A session sees at most ~5 tools.

> **Why:** each tool is a decision the model can get wrong. Read-only tools cost a step and are often skipped. Irrelevant tools get used anyway.
>
> **Measured:** with card status and memory pushed as context, and the researcher limited to search, fetch and read, research cards reached 100% and status questions were answered from real results.

### P5. The board is the only bus between agents

Agents never message each other. Inter-agent communication is card creation, results, comments and dependencies, persisted in the database. The owner adds to running work through `add_to_card`, which becomes a comment.

> **Why:** a durable board makes every handoff explicit, inspectable, resumable and editable by the owner. Agents chatting directly would need waiting sessions and free-text interpretation, both weak-model weaknesses.

### P6. Sessions are short, fresh and disposable

No session waits. A parent that needs its children's results ends; a new synthesis session starts later with those results as inputs.

> **Why:** long sessions drift, overflow and are lost on crash.

### P7. Route by topic, and let the model do the routing

Every message belongs to a topic. A topic is known structurally when the owner writes on a topic page or answers a question. Everything captured is routed by the model.

> **Why:** subject and stream are different things; one capture can carry many subjects. A clearly named topic is recognized by the model as reliably as by any rule, so one routing mechanism suffices (owner decision). **Measured:** router accuracy 100% in the benchmark.

### P8. Make assumptions visible and corrections cheap

Where Sandman guesses (topic routing, segmentation, memory merges, tidy-up), the guess is visible and can be corrected with one action. Every action taken on the owner's behalf has an undo.

> **Why:** a visible, cheaply corrected guess is nearly as good as a correct one, and it lets Sandman act immediately instead of asking. That is what makes capture without a screen possible.

### P9. Memory is pushed, and the librarian is what prevents redundant work

The harness assembles relevant memory before a session starts. The **librarian's `answered` decision** is the mechanism that avoids redoing work.

> **Why:** a model can't ask about what it doesn't know exists.
>
> **Measured:** workers given memory as context still re-searched about a third of the time; a librarian `answered` decision costs zero worker steps.

### P10. Memory is written offline, with provenance

Workers propose candidate facts; an offline consolidator decides what enters memory.

> **Why:** curating memory mid-task would split a weak model's attention and produce duplicates. **Measured:** consolidator decisions reached 100% with the 4-question rubric.

### P11. Everything is traced, and tracing comes first

Every LLM call, tool call and session is logged and linked. A read-only inspection UI exists before the chat UI.

> **Why:** with weak models, quality comes from iterating the harness against real traces. **Measured:** most issues found during benchmarking were found by reading traces.

### P12. The harness records what it can measure

Facts the harness can observe (files written, commands run and their exit codes, cards and reminders created, pages fetched) are recorded by the harness rather than reported by the model. Where they matter to a judgment, they are **given to** the judging model.

> **Why:** models report outcomes confidently whether or not they happened (tests passing, a reminder sent, a card updated). Harness records are correct by construction.

### P13. The harness surface is the product

Context packing, toolset shape, tool descriptions and **tool-result wording** are first-class, versioned, tested design surfaces, like prompts.

> **Measured:** harness changes raised the harder tasks from 65% to 90% and cut cost by a quarter, while switching models moved scores by ±3 points. The tool-result sentence "Created card X. Handle anything else the message asks for, then reply to Alex." made the desk both handle second requests and reply.

---

## 3. System overview

```
                          ┌──────────────────── Conversation layer ─────────────────────────────┐
 Phone / web / CLI ─┐     │ Capture ─► Transcribe ─► Segment ─► Route each item ─► Front desk   │
   capture          ├─► API  (voice, text, link)                                (capture mode)  │
   topic page ──────┤     │ Topic page message ───────────────────────────────► Front desk      │
   answers ─────────┘     │ Answers ─► Needs-you list / Briefing ─► unblock card  (conversation)│
      ▲                   └──────────────┬─────────────────────────────────────────┬────────────┘
      │ event stream                     │ receipts, confirmations                 │ new_work, reminder,
      └── Event log ◄── Notifier ◄───────┘ results, questions, review items        │ add_to_card, answer
                    ▲                                                              ▼
                    │                        ┌──────── Work layer ───────────────────────────┐
                    └────────────────────────│ Scheduler ─► Board (cards, deps)              │
                                             │ Dispatcher: Librarian → Triage → Planner →    │
                                             │ Worker → Verifier → Synthesis                 │
                                             └──────────┬──────────────▲────────────────────┘
                                              candidate │              │ context packs
                                              facts     ▼              │
                                             ┌──────── Memory layer ─────────────────────────┐
                                             │ Fact queue ─► Consolidator ─► Notes            │
                                             │ Topic tidy-up (nightly) · Retriever · Log (FTS)│
                                             └────────────────────────────────────────────────┘
   Cross-cutting: LLM gateway (schemas, quirks, profiles, guards) · Speech model · Trace store · Inspection UI
```

### 3.1 Components

| Component | Layer | LLM? | Responsibility |
|---|---|---|---|
| Unified API | Conversation | No | The only way in or out: captures, topic pages, messages, questions, briefings, review, cards, memory, inspection, event stream. |
| Event log | Conversation | No | Append-only log of everything clients need to render. Clients sync by cursor. |
| Capture pipeline | Conversation | Partly | Transcription (speech model), merging, segmentation into items with verified quotes (§6.3). |
| Router | Conversation | Yes | One `route_item` call per capture item; code picks the candidates, the model the answer (§6.4). |
| Front desk | Conversation | Yes | The only agent that talks to the owner: intent → arguments → reply (capture or conversation mode, §6.6). |
| Topic pages | Conversation | No | State of a topic assembled in code: summary, questions, cards, facts, conversation (§6.5). |
| Needs-you list | Conversation | No* | All blocking questions, ranked by waiting work; answer matching (*`match_answer` only when code can't match) (§6.9). |
| Briefing | Conversation | No* | Harness-driven question-and-answer dialogue for voice (§6.10). |
| Review pile + tidy-up | Conversation | Partly | Uncertain filings, unfiled text, overnight merge/project/archive suggestions (§6.11). |
| Notifier | Conversation | No | Notification level per event; quiet hours, interrupt budget, client modes (§6.12). |
| Board | Work | No | Cards, dependencies, comments, events, leases. |
| Scheduler | Work | No | Reminders and recurring schedules → cards/messages. |
| Dispatcher | Work | No | Drives the card state machine; runs sessions; applies outcomes atomically. |
| Librarian | Work/Memory | Yes | Pre-flight: does memory answer or narrow this card? |
| Triage | Work | Yes | Does this card fit one session? Is information missing? |
| Planner | Work | Yes | Decomposes a root card into children (recipe first). |
| Worker | Work | Yes | Executes a card with a role toolset; ends with `finish`, `block` or `fail`. |
| Verifier | Work | Yes | One judge call per `done_when` criterion, with harness-recorded facts. |
| Consolidator | Memory | Yes | Offline merge of candidate facts into notes and claims. |
| Retriever | Memory | No* | Entity lookup, FTS (+ optional vectors), context assembly. (*Embedding model only.) |
| LLM gateway | Cross-cutting | — | All model calls: schemas, quirk handling, validation, guards, streaming, logging. |
| Trace store + inspection UI | Cross-cutting | No | Sessions, tool calls, LLM calls, card timelines, capture pipelines. |

### 3.2 Suggested technology

- Python 3.12, asyncio; FastAPI for the API, server-sent events (SSE) for the event stream.
- SQLite in WAL mode, FTS5; `sqlite-vec` only if embeddings earn their keep (§19).
- LLM access through an OpenAI-compatible HTTP API; llama.cpp server locally (streaming, JSON schema / GBNF). OpenRouter or similar for benchmarking.
- Speech-to-text: a local Whisper-class model (e.g. whisper.cpp or faster-whisper) behind the `speech` profile. Text-to-speech is the client's job (OS voices) in v5.
- The web UI and any local app are separate projects that consume the API (Appendix B).

---

## 4. Core concepts

| Term | Definition |
|---|---|
| **Owner** | The single human user. |
| **Client** | A program using the API (web UI, local app, CLI, a future bridge). Authenticated by its own token. Clients have no routing meaning. |
| **Topic** | A subject with a slug and title. Owns messages and root cards, and has a rolling summary. States: `active`, `archived`. |
| **Topic page** | The view of a topic: where things stand, needs you, work, decisions and facts, then the conversation. Assembled in code. |
| **Capture** | Anything the owner sends without choosing a topic: a voice memo, a typed note, a shared link. |
| **Capture item** | One part of a capture, found by the segmenter and quoting its own words from the transcript. Routed and handled on its own. |
| **Capture mode / conversation mode** | How the desk handles input: a capture item is acted on and confirmed from receipts; a message on a topic page gets a normal reply. |
| **Receipt** | The harness's record of an action taken for the owner (card created, reminder set…), shown with an undo. |
| **Needs-you list** | All questions that block work, from every topic, ranked by how much work waits on each. |
| **Briefing** | A harness-driven dialogue that reads out needs-you questions and news, and takes answers by voice or text. |
| **Review item** | A non-blocking suggestion or check: uncertain filing, unfiled text, merge/project/archive suggestion. |
| **Project** | Optional long-lived grouping of topics and cards that shares a memory brief. |
| **Card** | A unit of work on the board. |
| **Root card** | A card created by the desk, the scheduler or the owner (depth 0). |
| **Child card** | A card created by the planner (depth 1). Never split further. |
| **Session** | One LLM-driven execution for one card or one desk turn. |
| **Role** | Worker profile: toolset, preamble, result schema. |
| **Terminal action** | `finish`, `block` or `fail`. |
| **Recipe** | Reusable decomposition template. |
| **Harness-recorded facts** | What the harness observed during a session: files written, commands and exit codes, pages fetched, cards/reminders created. |
| **Note / claim** | A long-term memory document about one thing, and an atomic statement in it. |
| **Candidate fact** | A proposed claim awaiting consolidation. |
| **Event** | An append-only record in the event log. Clients render from events. |

IDs are ULIDs with type prefixes: `crd_` card, `top_` topic, `prj_` project, `msg_` message, `cap_` capture, `itm_` capture item, `qst_` question, `rev_` review item, `brf_` briefing, `not_` note, `clm_` claim, `fct_` fact, `ses_` session, `tcl_` tool call, `cal_` LLM call, `art_` artifact, `sch_` schedule, `rcp_` recipe, `cli_` client. Event IDs are monotonically increasing integers, used as sync cursors.

> **Why prefixed IDs:** logs and prompts become self-describing, and the model can't confuse a card ID with a note ID.

---

## 5. Work layer: board, cards and cross-agent communication

### 5.1 The card

A card is a **contract**: everything a session needs, and nothing a session can't derive from it.

```yaml
id:            crd_01J...
title:         "Compare drip irrigation kits for raised beds"
kind:          task            # task | reminder | scheduled | system
role:          research        # research | write | synthesize | code
goal:          "Find drip kits sold in Switzerland suitable for 3 raised beds (40 m²) ..."
done_when:                     # judge criteria, phrased about what the result contains (§5.8)
  - "Names at least 3 kits, each with price and coverage, or states that a value is not available"
  - "Recommends one kit and says why"
constraints:   ["Owner prefers low-maintenance options"]
inputs:        [card:crd_01H...]          # resolved by the harness into the context pack
budget:        {steps: 10, output_tokens: 1500}
depth:         0               # 0 = root, 1 = child
parent_id:     null
depends_on:    []
origin_topic:  top_01J...
project_id:    prj_01J...
state:         ready
phase:         execute         # execute | synthesize
attempt:       1
priority:      normal          # interactive | high | normal | background
created_by:    frontdesk       # frontdesk | planner | scheduler | owner | system
recipe:        {id: rcp_research_detail, step: gather}   # for planner-created cards
```

> **Why a contract:** a weak model can't recover missing context by looking around. A complete card can be picked up by a retry, a different model, or the owner.

### 5.2 Card kinds

| Kind | Executed by | Purpose |
|---|---|---|
| `task` | Librarian → (triage → planner) → worker → verifier | Normal work. |
| `reminder` | Harness only | At `due_at`, append a reminder message to `origin_topic`. |
| `scheduled` | Harness | At each firing, create a `task` card from a template. |
| `system` | Harness jobs | Consolidation, summaries, maintenance. Lowest priority. |

### 5.3 Card state machine

States: `new`, `ready`, `running`, `waiting`, `blocked`, `verifying`, `done`, `failed`, `cancelled`.

| From | Event | To | Notes |
|---|---|---|---|
| `new` | librarian `answered` | `verifying` | Result built from memory, `result.source = memory`. |
| `new` | triage `missing_info` | `blocked` | `blocked_reason = missing_info`; question to owner before any work. |
| `new` | triage `fits: yes`, or card is a child | `ready` | Children are never triaged for splitting. |
| `new` | triage `fits: no` → planner | `waiting` | Children created in `new`; parent depends on them. |
| `ready` | dispatcher claims | `running` | Lease acquired. |
| `running` | `finish` | `verifying` | |
| `running` | `block` | `blocked` | `blocked_reason = worker_question`. |
| `running` | `fail` or steps exhausted | `ready` / `blocked` / `failed` | Retry and escalation policy (§5.10). |
| `running` | lease expired | `ready` | Crash recovery; `attempt += 1`. |
| `verifying` | all criteria pass | `done` | Facts enqueued; parent re-evaluated; root reports to topic. |
| `verifying` | a criterion fails | `ready` | Verifier reasons appended as a comment; escalation policy applies. |
| `waiting` | a fan-out source child is `done` | `waiting` | Harness creates the fan-out children (§5.6). |
| `waiting` | all children terminal | `ready` | `phase = synthesize`, `role = synthesize`. |
| `blocked` (`missing_info`) | answered | `new` | Librarian and triage run again with the answer as a comment. |
| `blocked` (`worker_question`, `escalation`) | answered | `ready` | |
| any non-terminal | owner cancels | `cancelled` | Children cancelled recursively. |

Terminal states: `done`, `failed`, `cancelled`. Every transition writes a `card_events` row in the same transaction as the state change.

### 5.4 Pipeline for a new task card

```
new ─► Librarian ─► answered ─────────────────────────────► verifying
           │ narrow (goal rewritten) / proceed
           ▼
      is child? ──yes──────────────────────────────────────► ready ─► Worker ─► verifying
           │ no
           ▼
       Triage ─► missing_info ─► blocked (question)
           │ fits: yes ─────────────────────────────────────► ready
           │ fits: no
           ▼
      pick_recipe ─► recipe ─► plan_fill ─┐
           │ none                         ├─► children (new), parent waiting
           └──────► plan_generate ────────┘
```

### 5.5 Triage

Two gated calls (P2).

**`triage`**, always for root task cards. Input: title, goal, done_when, the role's tools with one-line descriptions, step budget, and the known recipes' titles shown **as context only** ("these multi-step plans exist"). Output:

```json
{ "analysis": "<≤40 words>",
  "fits": "yes | no",
  "missing_info": "<one short question for the owner> | null" }
```

**`pick_recipe`**, only after `fits: no`. Input: goal plus up to 6 recipes (title and one-line description) retrieved by FTS on the goal. Output: `{ "analysis": "...", "recipe_id": "<enum> | none" }`.

Rules:
- `missing_info` non-null → `blocked` before anything else, regardless of `fits`.
- Child cards skip triage.
- Optional code rule (§19, open question 1): if the goal names ≥ `compare_split_threshold` distinct items to compare, force `fits: no`.

> **Why gated:** the model answers "does this fit one session?" well when that's the only question, and "which recipe?" well when it has already been established that a recipe is needed.

### 5.6 Planner and recipes

The planner is a harness step on the parent card, not a separate card.

**Recipe mode** (preferred). A recipe is a template that ends with its work steps; **combining is always the parent's synthesis**:

```yaml
id: rcp_research_detail
title: "Research candidates, detail each, then compare in synthesis"
description: "For choosing among several options of one kind."
params:
  subject:  "what kind of thing to find"
  criteria: "the owner's comparison criteria, quoted from the request"
  max_items: "how many to detail (≤5)"
steps:
  - key: gather
    role: research
    title: "Find candidate {subject}"
    done_when: ["Lists up to {max_items} candidate {subject}, each with a name and one line why it fits"]
    result_items: true          # this step's result schema includes items[]
  - key: detail
    role: research
    fanout: {from: gather, field: items, max: "{max_items}"}
    title: "Detail {item.name}"
    done_when: ["Covers {criteria} for {item.name}, or states which of them are not available"]
# after all steps: parent synthesis (role synthesize) against the parent's own done_when
```

`plan_fill` fills the params. Output: `{analysis, subject, criteria, max_items}`. The prompt MUST say that criteria are **quoted or closely paraphrased from the owner's request, never invented**; the owner's request is included verbatim.

**Fan-out.** A step marked `result_items: true` uses a result schema with `items: [{name, note}]`. When it finishes, the harness creates one child per item (up to `max`) and adds them to the parent's dependencies.

**Free mode** (`plan_generate`, when `pick_recipe` returns `none`): 2–5 subtasks `{title, goal, role (enum with descriptions), done_when[]}`, executed in parallel; no dependencies between children in v5. The parent's synthesis combines them.

> **Why independent children in free mode:** recipes cover sequential patterns, and the parent's synthesis combines parallel results.

### 5.7 Worker sessions

A worker session is a loop of up to `budget.steps` calls (`worker_step`). Each call returns exactly one action: a tool call from the role's *currently applicable* tools, or a terminal action.

```json
{ "oneOf": [
  {"action": "tool",   "tool": "<enum of applicable tools>", "tool_args": { ... }},
  {"action": "finish", "result": { ... role result schema ... }},
  {"action": "block",  "analysis": "...", "question": "...", "question_options": ["..."]},
  {"action": "fail",   "analysis": "...", "category": "impossible | out_of_scope | unclear | tool_error"}
]}
```

Key names are chosen so that alphabetical order equals the intended generation order: `tool` before `tool_args`, `question` before `question_options` (P3).

- **Last step:** only `finish`, `block` and `fail` are offered, and the footer says "This is your final step."
- **Steps exhausted without a terminal action** (e.g. repeated invalid output) counts as `fail(tool_error)`.
- **Applicability:** `read_artifact` only if the card or its inputs have artifacts; `write_artifact` only for roles that produce deliverables.

**Roles and toolsets:**

| Role | Tools | Result schema |
|---|---|---|
| `research` | `web_search(query)`, `web_fetch(url)`, `read_artifact(id, from_char)` | `summary`, `facts[]`, `open_questions[]`, `items[]` (recipe steps only), `sources[]` |
| `write` | `read_artifact`, `write_artifact(name, what)` | `summary`, `facts[]` |
| `synthesize` | `read_artifact`, `write_artifact(name, what)` | `summary`, `recommendation?`, `facts[]`, `open_questions[]` |
| `code` | `list_dir`, `read_file`, `write_file(path, what)`, `run(cmd)` | `summary` |

**Two-step content generation.** `write_artifact(name, what)` and `write_file(path, what)` do not carry the content. The harness makes a plain-text `generate_content` call (no JSON) with the card context, the relevant inputs, and `what` as the instruction. The output is saved, and the tool result reports the name and size, plus the first lines for code. Newlines and formatting survive because nothing is JSON-escaped.

**Context pack order: static first** (so a local server's prompt cache can reuse the prefix across steps and cards):

1. Role preamble (fixed per role and version).
2. Tool descriptions: one line each, applicable tools only.
3. Result schema description and terminal action rules.
4. Owner profile note.
5. Card contract: title, goal, constraints, done_when.
6. Project brief (if any).
7. Memory: relevant notes **with their active claims** (§7.6). No note-opening tool.
8. Inputs: sibling/child results (summary, items, open questions) and artifact list (`art_id — name — size`).
9. Comments: verifier reasons, owner additions (`add_to_card`), answers to questions.
10. This session's steps so far: action + tool result.
11. Footer: "Step k of n. Choose exactly one action." (plus the final-step notice).

Each slot has a safety cap (§17). **Measured:** worker steps average ~540 input tokens, so caps rarely bind.

**Tool results are prompt surface (P13).** Each tool's result template states what happened and, where useful, what to do next. Templates are versioned in `prompts/tool_results/` and evaluated with the harness suite. Examples:

- `web_fetch`: `[characters 0–2500 of 6106 from <url>. Continue with read_artifact(art_x, 2500) if needed.]` followed by the text. The position header comes **first** so truncation can't remove it.
- A repeated identical call: `You already ran this in step 3; its result is above. Choose a different action.`

### 5.8 Verification

- **Every `done_when` criterion is a judge criterion.** Planners and the desk write criteria as free text.
- One `verify_criterion` call per criterion. Output `{"analysis": "...", "verdict": "pass | fail"}`, reasoning first.
- The judge sees: the criterion, the result (summary, items, recommendation, open questions), **harness-recorded facts** (files written with names and sizes, the last `run` command's exit code and output tail, fetched URLs), and excerpts of artifacts the criterion refers to.
- **Criteria authoring rules** (used in the desk, planner and recipe prompts):
  - Describe what the *result* contains, not how it was produced, and only what the judge can see. Say "the result includes the email text", not "the email is saved".
  - For research: "covers X, **or states that X is not available**", so honest "not found" answers can pass.
  - Keep to 1–3 criteria per card.
- On failure, the judge's `analysis` is appended as a comment for the next attempt. **Measured:** this resolves most second attempts.

### 5.9 How results flow back

- A child's result is stored on the card; the parent's dependencies are re-evaluated.
- The parent's synthesis session receives each child's `{title, state, summary, items, open_questions, artifact list}`, never transcripts. Failed or cancelled children are included with their reason.
- A root card reaching a terminal state appends a structured `card_result` message to its `origin_topic`: title, summary, recommendation, artifacts, state. Clients render it; no LLM call is needed (§6.8).

### 5.10 Retry and escalation

On `fail`, verification failure, or lease expiry:

1. `attempt < max_attempts` (default 2) → `ready`, with the failure reason as a comment.
2. If a `large` profile is configured → one attempt on it.
3. Otherwise → `blocked` (`escalation`) with a question to the owner: "*Card X* failed twice: <reason>. Retry / cancel / add guidance?"

`fail(out_of_scope | unclear)` skips step 1.

### 5.11 Dispatcher, leases and concurrency

- Pick the highest-priority runnable card, acquire a lease, run the appropriate step, apply the outcome **in one transaction**. Renew the lease after each worker step; reclaim expired leases at startup and periodically.
- The gateway exposes N concurrent **slots** per model profile. Priorities: `interactive` (router, desk) > `high` (synthesis, unblocked cards) > `normal` > `background`.
- One slot SHOULD be reserved for interactive calls, or a separate small profile SHOULD serve the router and desk. An owner message must never wait behind a long worker session.
- Unmeasured so far (§19): behaviour under a single slot on a local model.

### 5.12 Hard limits (defaults)

| Limit | Default | Why |
|---|---|---|
| Tree depth | 1 (root + children) | Children are never split; synthesis happens once. |
| Children per plan / fan-out | 5 | Keeps synthesis input small. |
| `max_attempts` | 2 | Then escalate; blind retries waste slow compute. |
| Steps per role | research 10, write 6, synthesize 6, code 15 | Tune from traces. |
| LLM calls per root card tree | 40 | Budget in calls, not context (§15). Exceeding it blocks to the owner. |

### 5.13 Comments

Any actor can append a comment to a card: the owner (via `add_to_card` or the API), the verifier, the harness. Comments appear in the next session's context (slot 9). This is how owner follow-ups, answers and feedback reach work without agent-to-agent messaging.

An owner follow-up on a `running` card takes effect at the worker's **next step**: the harness re-renders slot 9 each step. On a `done` card, `add_to_card` reopens it as a new root card with the old result as input and the addition as a constraint.

---

## 6. Conversation layer: capture, topics, attention

### 6.1 Three jobs, three surfaces

A chat window bundles three different jobs. Sandman separates them:

| Job | Owner's question | Surface | Rule |
|---|---|---|---|
| **Capture** | "How do I get this out of my head?" | Quick capture: voice memo, text, shared link | Capture never requires a choice. No topic, no channel. |
| **Organization** | "Where does this belong, and where do things stand?" | Topic pages, review pile, overnight tidy-up | Automatic first. The owner confirms or corrects by exception. |
| **Attention** | "What needs me?" | Needs-you list, briefings, notifications | One ranked list across all topics. Everything else waits quietly. |

The owner talks to Sandman in exactly two ways:

- **Capture** (§6.3): from anywhere, without context. Sandman splits, files and acts.
- **Conversation on a topic page** (§6.5): when the owner opens a topic and writes there, the topic is known, and the desk replies normally.

Answers to questions go through question widgets, the needs-you list, or a briefing (§6.9, §6.10).

> **Why:** a chat window forces the owner to decide where a thought goes before saying it, and mixes "please file this" with "please talk to me" and "this is waiting for you". Separating the jobs lets each be simple: capture is one button, organization happens in the background, attention is one list.

### 6.2 API, messages and the event log

Sandman owns all state; clients (web UI, phone app, CLI) are views of it (Appendix B).

- **Messages** belong to exactly one topic. `role`: `owner` or `sandman`. `kind`: `text`, `capture_item`, `card_result`, `question`, `reminder`, `receipt`, `system`. Structured kinds carry a JSON `payload` for rendering (option buttons, card links, undo actions).
- **Events** are an append-only log with increasing integer IDs, which clients sync by cursor (`GET /events?after=`, or SSE). Everything a client might show is an event, including `capture.received`, `capture.transcribed`, `capture.segmented`, `item.routed`, `capture.confirmed`, `topic.*`, `card.*`, `question.*`, `review.*`, `briefing.*`, `desk.working` and `desk.idle`. Each event carries a `notify` level (§6.12).
- All clients see the same history. After a disconnect they resume from their cursor.

### 6.3 Quick capture

`POST /captures {text? | audio?, url?, client_msg_id, source}`, where `source` is `voice`, `text`, `share` or `cli`. This is the single entry point for "just telling the swarm something", from a phone widget, a voice memo button, the share sheet, a watch or a terminal.

**Transcription.** Audio is transcribed on the Sandman host by a local speech model (the `speech` profile, e.g. a Whisper-class model). Its vocabulary prompt is built from active topic titles and entity note titles, capped at ~200 tokens, so names come out right. The transcript is stored on the capture; the audio is kept as an artifact for `capture_audio_days` (default 7). A client MAY transcribe on the device and send text instead.

**Merging.** Captures from the same client within `capture_merge_seconds` (default 10) are merged before segmentation, so "…oh, and one more thing" in a second memo belongs to the same capture.

**Segmentation.** If the capture is longer than one sentence or 30 words (a length rule, not a content rule), `segment_capture` splits it into items:

```json
{ "analysis": "…",
  "items": [ { "quote": "<the exact words from the transcript for this item>" } ] }
```

- Each item MUST quote its own words from the transcript. The harness checks every quote against the transcript (normalized case and whitespace, fuzzy match with ≥90% token overlap). Quotes that don't match are dropped; if none match, the whole capture becomes one item.
- Transcript text of more than 8 words that no item covers becomes a review item (§6.11): "Part of your memo wasn't filed: '…'", with actions *File* and *Ignore*.
- Shorter captures become a single item without a model call.

> **Why quotes:** extraction with verbatim quotes is something weak models do reliably, and quoting prevents invented or merged items. The coverage check makes dropped content visible instead of silently lost.

**Items.** Each item becomes a `capture_items` row and a `capture_item` message in the topic it's routed to (§6.4). It is then handled by the front desk in **capture mode** (§6.6). The desk sees the item's quote plus the full transcript, so references like "that kit" can be resolved.

**Shared links.** A `url` on the capture is stored as an artifact reference on every item. If an item creates a card, the link is added to the card's inputs.

### 6.4 Routing: always the model

A topic is known without routing in exactly two cases, both structural: the owner writes **on a topic page** (the message carries `topic_id`), or **answers a question** (the answer carries `question_id`). Every captured item is routed by the model.

> **Why (owner decision):** a topic named clearly enough to be recognized is recognized by the model, so one mechanism handles named and unnamed topics alike, including transcription variants ("guarding: …"). **Measured:** router accuracy 100% in the benchmark. When the owner says "Garden: …", the router prompt tells the model to follow an explicitly named topic.

**`route_item`**, one call per item:

- **Candidates** (code decides which *options* to show, never the answer): the 6 most recently active topics, plus up to 3 topics (archived ones included) that match the item's words in FTS, plus `new`. Each is shown as `slug — title — one-line summary`.
- **Output:** `{analysis, choice: <slug enum> | new, confidence: high | low}`.
- `new` → `topic_title` (≤6 words); the slug is derived in code.
- Choosing an archived topic reactivates it.
- `confidence: low` → the item is still filed and handled, marked `provisional`, and a `filing_check` review item is created (§6.11). Capture never waits for the owner.

**Moving.** `POST /items/{id}/move {topic_id | "new"}` moves the item's message, re-parents any cards and reminders it created, moves its receipts, and records a routing example for the eval set.

### 6.5 Topic pages

A topic is a **page that shows where things stand**, with the conversation underneath. `GET /topics/{id}/page` assembles it in code, so opening a page costs no model calls:

1. **Where things stand:** the rolling summary (≤150 words, maintained by `summarize_topic` in the background; rebuilt from source every 20 messages).
2. **Needs you:** this topic's open questions, with option buttons (§6.9).
3. **Work:** the topic's root cards and their children, with states and result summaries.
4. **Decisions and facts:** owner-sourced claims from this topic's messages, plus the most relevant claims from notes linked to its cards. Each line shows its source ("you said, 28 Sep" / "from memory") and can be edited or deleted. Edits go straight into memory as owner-sourced changes (§7.4).
5. **Conversation:** the message timeline: owner messages, filed capture items, desk replies, receipts and card results.

**Talking on a topic page.** `POST /messages {topic_id, text, client_msg_id}` runs the desk in **conversation mode** (§6.6). Messages sent in quick succession are coalesced: the client MAY send `POST /typing {topic_id}`, and the desk starts after `debounce_quiet_seconds` (default 4) without a message or typing signal, capped at 60 s.

> **Why pages:** the owner mostly wants to know the state of something, not reread a conversation. The summary, questions, cards and facts already exist in the harness. Showing them costs nothing and removes the need for status questions.

### 6.6 Front desk: capture mode and conversation mode

The desk is the only agent that talks to the owner. Each turn is stateless and starts from the topic record.

**Context (static first):** desk preamble with the owner's name; the intents with one-line descriptions; the owner profile; topic title and summary; project brief (if any); the last 8 messages; open and recent cards as one line each (`title — state — result summary if done — open question if blocked`); this topic's open questions; relevant notes with claims; the input. In capture mode the input is the item's quote plus the full transcript; in conversation mode it is the message(s).

**Turn structure: intent, then arguments, then (maybe) a reply** (P2):

```
loop (max 3 actions):
    desk_intent  → {analysis, intent}
        first pass:  new_work | reminder | answer_question* | add_to_card* | reply_only | nothing
        later:       new_work | reminder | answer_question* | add_to_card* | done
        (* only when applicable; answer_question at most once per turn)
    if intent in (reply_only, nothing, done): break
    desk_args_<intent> → arguments for that one action
    harness executes it, records a receipt (with an undo handle)
reply:
    conversation mode → desk_reply (plain text), unless the intent was `nothing` with no actions
    capture mode      → desk_reply only if the intent was reply_only (the owner asked something,
                        so the answer is the point; kept short and speakable).
                        Otherwise no reply; the capture confirmation (§6.7) reports the receipts.
```

| Intent | Arguments (`desk_args_*`) | Executes | Receipt |
|---|---|---|---|
| `new_work` | `{analysis, done_when[1–3], goal, role (described enum), title}` | Root card with `origin_topic` | "New card · *T*" |
| `reminder` | `{text, when_text}` | Harness parses `when_text` in the owner's timezone; creates a `reminder` card in this topic | "Reminder · Fri 2 Oct 09:00" |
| `answer_question` | `{question_id (enum of this topic's open questions), response}` | Answer flow (§6.9) | "Answered: *Q*" |
| `add_to_card` | `{card_id (enum of open/recent cards), note}` | Comment on the card (§5.13) | "Added to *T*" |

After each action, the next `desk_intent` call sees the receipts so far, with the tool-result wording from P13 ("Created card X. Is there anything else in this item that still needs an action?"). `desk_reply` may only refer to actions that appear in the receipts. The receipts are also shown as structured `receipt` messages, independently of the reply text (P12).

Reminders are always created in the item's own topic. A capture that mixes subjects is split by the segmenter before the desk sees it, so no cross-topic argument is needed.

> **Why intent before arguments:** the kind of action is the desk's most consequential choice. As a classification over described options it is reliable, and the arguments are then generated for a known action. **Decision point (M3):** benchmark this against a single tool loop that uses the tool-result wording from P13; keep the split unless the loop scores at least as well on multi-intent and reminder episodes.
>
> **Why no reply in capture mode:** the owner didn't start a conversation; they dropped something off. A generated reply costs one call per item on a slow model, and the receipts already say what happened.

### 6.7 Confirmations, receipts and undo

**Capture confirmation.** When every item of a capture has been handled, the harness builds one confirmation from the receipts, using a template and no model: "Got it, three items. Added to drip kits. Reminder for Friday, 9:00. New topic: bike repair." It goes out as a `capture.confirmed` event with `text` (for display) and `speech` (a shorter form for text-to-speech). If an item's desk turn produced a `reply_only` answer, that answer is appended. The confirmation can only mention what actually happened, because it is built from receipts (P12).

**Undo.** Every receipt carries an undo action, available until its effect has been consumed:

| Receipt | Undo |
|---|---|
| New card | Cancel the card (and delete it if no session has run yet). |
| Reminder | Delete the reminder. |
| Added to card | Delete the comment; if a session has already seen it, add "Owner withdrew: …" instead. |
| Answered question | Reopen the question if the card hasn't resumed yet; otherwise offer "correct the answer" (a comment). |
| Filed under topic | This is *Move* (§6.4). |

**Confirm by exception.** Cheap, reversible actions run immediately. Actions with outside effects (§12) always go through an `approval` question in the needs-you list.

> **Why:** voice gets misheard. Undo makes "act now, correct later" safe, and correcting later is what lets capture work without a screen.

### 6.8 Messages from Sandman

Everything Sandman says is a message in a topic, or an event:

| Source | Appears as | LLM? |
|---|---|---|
| Desk reply (conversation mode, or a capture question) | `text` message | yes (`desk_reply`) |
| Desk action | `receipt` message with undo | no |
| Capture handled | `capture.confirmed` event (text + speech) | no |
| Root card finished/failed/cancelled | `card_result` message (title, state, summary, recommendation, artifacts) | no |
| Card blocked, approval needed, memory conflict | `question` message + needs-you entry | no |
| Reminder due | `reminder` message | no |
| Uncertain filing, unfiled text, tidy-up suggestion | review item (§6.11) | no |
| System alert | `system` message in the `sandman` system topic | no |

Results are structured by default and rendered by clients. `report_mode: desk` optionally phrases them with a model call.

### 6.9 Needs you

Every question that blocks work, from every topic, appears in one **needs-you list**. Each question also appears on its topic's page.

**Question kinds** (`questions.reason`): `worker_question` (worker `block`), `missing_info` (triage), `escalation` (§5.10), `approval` (side effects, §12), `memory_conflict` (§7.5).

**Ranking** (code): first by the number of cards waiting on the question (the blocked card plus every card that depends on it, directly or transitively), then by age. Questions that block nothing (e.g. memory conflicts) come last.

**Written for voice.** A question is ≤25 words with 2–4 numbered options of ≤6 words each. The worker `block` schema, the escalation template and the conflict template enforce this. `missing_info` questions may have no options, in which case they take a free answer.

**Answer paths:**
- An option button, on the topic page or in the list: `POST /questions/{id}/answer {option}`.
- Free text or speech: `POST /questions/{id}/answer {text | audio}`.
- The desk intent `answer_question`, when the owner answers in a topic conversation.
- A briefing (§6.10).

**Answer matching.** Code first: a number word or digit ("one", "2", "the first"), the exact text of an option, yes/no for two-option yes/no questions, and "skip". Otherwise `match_answer` → `{analysis, choice: <option enum> | free_text}`. A free-text answer is stored as text. Either way, the full answer goes into the card's comment.

**Effect:** the card is unblocked (`ready`, or `new` for `missing_info`). An unanswered question is escalated once, to `push`, after `question_nag_hours` (default 24).

> **Why one list:** in a swarm, the owner is the bottleneck. Blocked cards sit idle until someone answers, so the list is ranked by how much work waits on each answer.

### 6.10 Briefings

A briefing is a short, harness-driven exchange for clearing the needs-you list and catching up, designed for voice (driving) but also usable on screen.

**Start:** on demand (`POST /briefings`, a "Brief me" button, or automatically when a client switches to `driving` mode), or on a schedule (`briefing_at`, e.g. 07:30).

**Content** (templates, no model):
1. "N things need you." Each needs-you question in rank order, read with its numbered options.
2. Finished work since the last briefing: card titles and one-line summaries.
3. Today's reminders.

**Dialogue** (a harness state machine): read an item → wait for the answer → match it (§6.9) → confirm ("Last year's accountant.") → next. The words "skip", "repeat" and "stop" are recognized by code. Transport: `POST /briefings/{id}/reply {text | audio}` returns the next prompt as `{text, speech}`. Text-to-speech runs on the client in v5.

**Cost:** zero model calls per answer, unless an answer needs `match_answer`.

> **Why the harness drives it:** a dialogue in which the model decides what to say next is exactly the long-horizon task weak models do badly. Here the harness knows the script; the model only interprets answers it can't match.

### 6.11 Review pile and topic tidy-up

**Review items** are non-blocking suggestions. They appear in a review list and on the affected topic page, and never push.

| Kind | Created by | Actions |
|---|---|---|
| `filing_check` | Low-confidence routing (§6.4) | Looks right / Move to… |
| `unfiled_text` | Segmenter coverage check (§6.3) | File / Ignore |
| `topic_merge` | Tidy-up job | Merge / Keep separate |
| `topic_project` | Tidy-up job | Make project / Not now |
| `topic_archived` | Tidy-up job (notice) | Undo |
| `recipe_promotion` | §7.8 | Save as recipe / No |

**Tidy-up job** (nightly, after consolidation, as a `system` card at background priority):
- **Merge:** code finds candidate pairs (FTS similarity of titles and summaries above a threshold). For each pair, `topic_same` → `{analysis, same: yes | no}`; "yes" creates a `topic_merge` item. Accepting moves messages, cards and questions into the kept topic, and the other slug becomes an alias.
- **Project:** a code rule. A topic with ≥ `project_card_threshold` (default 6) cards and no project gets a `topic_project` item. Accepting creates a project and its brief (§7.7).
- **Archive:** a code rule. A topic with no messages for `archive_after_days` (default 14) and no open cards or questions is archived, and a `topic_archived` notice with Undo is created. Archived topics are not in the router's recency candidates but can still be matched by FTS, and routing to one reactivates it.
- **Split:** not in v5 (§19).

Topics therefore have only two states: `active` and `archived`.

> **Why suggestions overnight:** organization mistakes are cheap and never urgent. Batching them keeps them off the interactive model slot. Pairwise yes/no is a question the model answers well, and the owner sees only what it proposes.

### 6.12 Notifier

Each event gets a `notify` level:

| Level | Meaning | Default for |
|---|---|---|
| `push` | Interrupt (OS or phone notification) | Questions that block work, reminders, urgent alerts |
| `badge` | Unread marker, no interruption | Card results, desk replies, questions over budget |
| `silent` | Timeline only | Receipts, routing, card state changes, review items |

Rules (config):
- **Interrupt budget:** at most `max_push_per_day` (default 6) pushes. Beyond that, pushes become badges and are included in the next briefing. Reminders and urgent alerts don't count against the budget.
- **Quiet hours** downgrade `push` to `badge`, except reminders set for that time and urgent alerts.
- **Client mode** (`POST /presence {mode, topic_id?}`):
  - `active` on a topic: no push for that topic.
  - `driving`: no pushes except reminders; capture confirmations and replies are delivered with their `speech` form.
  - `dnd`: urgent alerts only.
- **Dedupe:** reminders and schedules have idempotency keys (`schedule_id + fire_time`).
- **Delivery when no client is open:** Web Push. A client registers an endpoint via `POST /push-subscriptions`, and Sandman calls it for `push` events.

### 6.13 Future bridges

A messaging bridge (Matrix, email) would be an ordinary API client outside the core. It would post incoming messages as captures and render events back. The core stays unchanged.

---

## 7. Memory layer

### 7.1 The two hard questions

**"How does a model know to ask for what it doesn't know?"** It doesn't have to. The harness knows the card's goal, project and entities, and what the library holds. It retrieves before the session starts and puts the relevant notes, with their claims, into the context (P9). Before any work starts, the **librarian** decides whether memory already answers the card.

**"How are memories committed, and what is relevant?"** Workers propose candidate facts in a field they fill anyway. An offline consolidator decides, using four yes/no questions and a keep-rule in code, with the existing notes in view. Everything carries provenance and a volatility class.

### 7.2 Tiers

| Tier | Content | Written by | Read by | Pushed by default? |
|---|---|---|---|---|
| Working | Cards, results, comments, artifacts | Harness, workers | Sessions via inputs | Yes, per card |
| Episodic log | All messages, results, tool calls, LLM calls (FTS) | Harness | Consolidator, owner, inspection UI | No |
| Semantic notes | Entity notes, project briefs, topic notes, negative results | Consolidator, owner edits | Librarian, retriever | Relevant notes with claims |
| Profile | Owner preferences, constraints, standing decisions | Consolidator (owner-sourced facts only), owner edits | Every desk turn and worker session | Always (≤300 tokens) |
| Procedural | Recipes | Owner (promotion) | Triage, planner | Recipe titles in triage |

### 7.3 Notes and claims

A **note** is about exactly one thing. Kinds: `entity` (a product, organization, place, concept, public person, API), `project_brief`, `topic`, `negative` ("searched for X on date D, found nothing / approach failed because…"), `profile` (exactly one).

```yaml
note:  {id: not_…, kind: entity, title: "Gardena Micro-Drip starter set", aliases: [...],
        one_liner: "≤20 words", project_id?, tags: [...], status: active|retracted}
claim: {id: clm_…, note_id, text: "Covers about 15 m² per kit.",
        source: {type: url|owner|card, ref, card_id?}, observed_at: 2026-09-20,
        volatility: evergreen|slow|volatile, status: active|superseded|disputed|retracted,
        superseded_by?, confidence: low|medium|high, corroborations: 0}
```

A note's body is **rendered** from its active claims. Superseded claims appear in a collapsed history in the UI and are never pushed into context.

> **Why entity notes with claims rather than vector chunks:** a natural merge target, exact-name lookup (the most reliable key for weak models), a place for "outdated", and a readable, editable artifact for the owner.

### 7.4 Candidate facts

Sources:

1. Worker results: `facts[]`.
2. Owner statements: `extract_owner_facts` runs with each topic summary update. It extracts **only** preferences, decisions, constraints and personal context stated by the owner (`source.type = owner`).
3. Negative results: a research card that fails with `impossible`, or finishes with a summary stating nothing was found, yields an automatic `negative` candidate built from its goal and reason.
4. Owner edits, on a topic page's "Decisions and facts" (§6.5) or in the memory browser: applied directly as owner-sourced claims, bypassing consolidation, and logged.

**Fact schema** (inside results; keys chosen so alphabetical order still puts the claim before its classification):

```json
{ "claim": "<one sentence>",
  "source": "<url | card | owner>",
  "subject": "<the thing the fact is about — a product, place, organization or concept. NOT a property such as 'Price' or 'Setup'>",
  "volatility": "evergreen | slow | volatile" }
```

> **Why:** a property as subject ("Price", "Setup") would create a note per property instead of attaching facts to the thing.

### 7.5 Consolidator

**Scheduling (MUST be automatic):** nightly at `consolidate_at` (default 03:00), plus opportunistically whenever the model is idle and ≥ `consolidate_min_pending` (default 20) facts are pending, plus on demand (`POST /memory/consolidate`). The topic tidy-up job (§6.11) runs right after each nightly consolidation.

For each pending candidate:

```
1. subject resolution
     exact / alias match on note titles                  → target note
     else FTS (+ vectors if enabled) top 3               → match_subject: {analysis, note_id enum | none}
          prompt includes: "A different thing of the same kind is none."
     else                                                → new entity note titled with the subject
2. relevance (skip for source = owner; always kept)
     relevance_rubric → {analysis, costly, reusable, task_mechanics, trivial}
     keep = not task_mechanics and not trivial and (reusable or costly)      ← code
3. merge
     top 5 active claims of the target note most similar to the candidate
     consolidate_fact → {analysis, decision, target_claim_id?}
        new          → insert claim
        duplicate    → corroborations += 1 (confidence may rise)
        update       → insert claim; supersede target (only if the candidate is newer)
        contradicts  → per policy below
        discard      → drop (logged)
4. mark affected project briefs dirty; re-render dirty notes' one-liners and briefs (from claims only)
```

> **Measured:** with the "different thing of the same kind" line and the 4-question rubric, subject matching and consolidation decisions reached 100%. Volatility comes from the worker's fact. Synthesis restates its children's facts, so duplicates are common; marking them `duplicate` costs about 2 calls each, which is fine offline.

**Contradictions:**
- `volatile` or `slow`, candidate newer, source of equal or better type → automatic `update`.
- `evergreen`, or different source types → both claims `disputed`, and a `memory_conflict` question in the needs-you list (§6.9), phrased for voice: "Two notes disagree on *X*: A or B? 1: A, 2: B, 3: keep both." Such questions block no work and therefore rank last.
- Owner-sourced claims about the owner always win over web-sourced ones.

The consolidator is the best place to spend a stronger model if one is available intermittently (`consolidator_profile`).

### 7.6 Librarian (pre-flight)

Runs for every new `task` card, both root and child (configurable per role; `code` may skip).

1. **Entity extraction** (`extract_entities`, ≤6 short strings). Skipped when the notes table is empty. **Measured:** about 115 input tokens; acceptable while memory is young.
2. **Exact/alias lookup** of the entities (code).
3. **Project brief** (code).
4. **FTS search** over note titles, aliases and one-liners, restricted to the project first and then global, top `k` (default 6). Vectors are optional (§19).
5. **Negative notes** matching the goal are always included if they score above a threshold.
6. **Staleness (code):** a claim is stale if older than its volatility's maximum age (`volatile` 7 days, `slow` 180 days, `evergreen` never). Stale claims are shown with `[as of <date>, may be outdated]`. A note whose relevant claims are all stale is **not answerable**: it is excluded from the `answer_note_ids` enum but can still inform `narrow`.
7. **Decision** (`librarian`), given the goal, done_when and the retrieved notes with their active claims:

```json
{ "analysis": "…",
  "answer_note_ids": ["<enum of answerable notes>"],
  "narrowed_goal": "… | null",
  "verdict": "answered | narrow | proceed" }
```

- `answered` → `render_answer` builds a result (summary plus facts) from the cited notes; the card goes to `verifying` with `result.source = memory`. If verification fails, the card continues normally with the memory result as an input.
- `narrow` → the goal is replaced (the original kept as `original_goal`) and a comment records "Narrowed using not_x, not_y". This is also how stale knowledge gets refreshed: "Check the current price of X (last seen CHF 89 on 20 Sep)".
- `proceed` → normal pipeline.

The retrieved notes, with claims, become slot 7 of the worker's context.

> **Why the librarian is *the* mechanism for not redoing work:** workers ignored "finish without searching" about a third of the time even when memory had the answer. A decision *before* the worker exists can't be ignored by the worker.

### 7.7 Project briefs

One `project_brief` note per project, always **re-rendered** from claims (never edited incrementally): *Goal*, *Status*, *Decisions (dated)*, *Key facts*, *Open questions*, *What didn't work*. ≤600 tokens. Pushed into every card and desk turn for that project.

### 7.8 Recipes

- Stored in a `recipes` table as YAML, curated by the owner.
- When a free-mode plan's root card finishes `done` with all its children `done`, the harness creates a `recipe_promotion` review item (§6.11): "The plan for *X* worked. Save it as a recipe?" On acceptance, `generalize_recipe` drafts params and step titles, and the owner edits the draft in the UI.

### 7.9 Forgetting and correction

- Deleting a fact line on a topic page (§6.5), or retracting in the memory browser, marks a claim or note `retracted`. Retracted claims are never pushed, and the consolidator won't re-create a claim from a retracted source.
- Owner corrections in conversation become owner-sourced facts that supersede older claims.
- Nothing is hard-deleted automatically; the owner can purge in the UI.

### 7.10 Episodic log

Everything is stored and FTS-indexed. It is the ground truth: `rebuild_memory` can replay candidate facts from it. Workers don't see it.

---

## 8. Workspace, artifacts and harness-recorded facts

- Each root card tree gets `workspace/<root_card_id>/`; each card writes into its own subdirectory.
- Artifacts are registered in `artifacts` (`art_`, name, path, mime, bytes, card_id, `summary` ≤30 words produced by a small `summarize_artifact` call, or taken from the `what` of the write action).
- Long tool results (fetched pages, command output over the window size) are **saved as artifacts automatically** and paged (§11).
- `code` role: `run` executes in a sandbox (container or bubblewrap) with the card directory mounted, no network by default, and CPU/time limits.

**Harness-recorded facts (P12).** For every session the harness keeps a record, derived from the `tool_calls` table:

```yaml
files_written:   [{art_id, name, bytes}]
commands:        [{cmd, exit_code, output_tail (last 40 lines)}]
pages_fetched:   [{url, chars}]
searches:        [{query, results}]
created:         [{kind: card|reminder|question, id, title}]      # desk turns
```

This record is shown to the verifier, rendered in the inspection UI, and summarized in `card_result` messages ("wrote report.md, 1,240 words"). The model is never asked to report any of it.

---

## 9. Data model (SQLite)

Suggested schema; `created_at` and `updated_at` omitted. JSON columns hold validated JSON. Card state changes go through one function that writes `cards` and `card_events` in one transaction.

```sql
-- API & conversation
CREATE TABLE clients        (id TEXT PRIMARY KEY, name TEXT, token_hash TEXT, last_seen_at TEXT,
                             mode TEXT /*active|driving|dnd*/, viewing_topic_id TEXT);
CREATE TABLE push_subscriptions (id TEXT PRIMARY KEY, client_id TEXT, endpoint JSON, active INTEGER);
CREATE TABLE projects       (id TEXT PRIMARY KEY, title TEXT, status TEXT, brief_note_id TEXT);
CREATE TABLE topics         (id TEXT PRIMARY KEY, slug TEXT UNIQUE, aliases JSON, title TEXT,
                             status TEXT /*active|archived*/, merged_into TEXT, project_id TEXT, is_system INTEGER,
                             summary TEXT, summary_msg_count INTEGER, last_activity_at TEXT, archived_at TEXT);
CREATE TABLE captures       (id TEXT PRIMARY KEY, client_id TEXT, client_msg_id TEXT, source TEXT /*voice|text|share|cli*/,
                             audio_artifact_id TEXT, url TEXT, transcript TEXT, merged_into TEXT,
                             state TEXT /*received|transcribed|segmented|handled|failed*/,
                             confirmation JSON /*{text, speech}*/, UNIQUE(client_id, client_msg_id));
CREATE TABLE capture_items  (id TEXT PRIMARY KEY, capture_id TEXT, seq INTEGER, quote TEXT,
                             topic_id TEXT, route_confidence TEXT, provisional INTEGER DEFAULT 0,
                             message_id TEXT, desk_turn_id TEXT);
CREATE TABLE messages       (id TEXT PRIMARY KEY, topic_id TEXT, role TEXT /*owner|sandman*/,
                             kind TEXT /*text|capture_item|card_result|question|reminder|receipt|system*/,
                             body TEXT, payload JSON, reply_to TEXT, client_id TEXT, client_msg_id TEXT,
                             capture_item_id TEXT, desk_turn_id TEXT,
                             UNIQUE(client_id, client_msg_id));
CREATE TABLE receipts       (id TEXT PRIMARY KEY, desk_turn_id TEXT, message_id TEXT,
                             kind TEXT /*card_created|reminder_set|added_to_card|answered|filed*/,
                             ref_id TEXT, undo JSON, undone_at TEXT);
CREATE TABLE events         (id INTEGER PRIMARY KEY AUTOINCREMENT, type TEXT, topic_id TEXT,
                             ref_id TEXT, payload JSON, notify TEXT /*push|badge|silent*/, at TEXT);
CREATE TABLE questions      (id TEXT PRIMARY KEY, card_id TEXT, topic_id TEXT, message_id TEXT,
                             text TEXT, options JSON,
                             reason TEXT /*worker_question|missing_info|escalation|approval|memory_conflict*/,
                             blocked_cards INTEGER /*ranking, maintained by the board*/,
                             status TEXT /*open|answered|expired*/, answer_option TEXT, answer_text TEXT,
                             answered_via TEXT /*button|text|voice|desk|briefing*/,
                             nagged INTEGER DEFAULT 0, answered_at TEXT);
CREATE TABLE review_items   (id TEXT PRIMARY KEY, kind TEXT /*filing_check|unfiled_text|topic_merge|topic_project|topic_archived|recipe_promotion*/,
                             topic_id TEXT, ref_ids JSON, payload JSON, status TEXT /*open|accepted|rejected|expired*/,
                             resolved_at TEXT);
CREATE TABLE briefings      (id TEXT PRIMARY KEY, client_id TEXT, trigger TEXT /*manual|driving|scheduled*/,
                             script JSON /*ordered steps*/, position INTEGER, state TEXT, started_at TEXT, ended_at TEXT);
CREATE TABLE desk_turns     (id TEXT PRIMARY KEY, topic_id TEXT, mode TEXT /*capture|conversation*/,
                             input_ref TEXT /*capture_item or message ids*/, session_id TEXT,
                             intents JSON, reply_message_id TEXT);

-- Work
CREATE TABLE cards          (id TEXT PRIMARY KEY, kind TEXT, role TEXT, title TEXT, goal TEXT, original_goal TEXT,
                             done_when JSON, constraints JSON, inputs JSON, budget JSON,
                             depth INTEGER, parent_id TEXT, root_id TEXT, origin_topic_id TEXT, project_id TEXT,
                             state TEXT, blocked_reason TEXT, phase TEXT, attempt INTEGER, priority TEXT,
                             created_by TEXT, recipe_id TEXT, recipe_step TEXT, fanout_item JSON,
                             due_at TEXT, lease_owner TEXT, lease_expires_at TEXT,
                             result JSON, result_source TEXT /*worker|memory*/, model_profile TEXT,
                             llm_calls_used INTEGER DEFAULT 0);
CREATE TABLE card_deps      (card_id TEXT, depends_on TEXT, PRIMARY KEY(card_id, depends_on));
CREATE TABLE card_events    (id INTEGER PRIMARY KEY, card_id TEXT, from_state TEXT, to_state TEXT,
                             event TEXT, actor TEXT, payload JSON, at TEXT);
CREATE TABLE comments       (id TEXT PRIMARY KEY, card_id TEXT,
                             author TEXT /*owner|verifier|harness|librarian*/, body TEXT);
CREATE TABLE artifacts      (id TEXT PRIMARY KEY, card_id TEXT, name TEXT, path TEXT, mime TEXT,
                             bytes INTEGER, summary TEXT, origin TEXT /*write|tool_result|upload*/);
CREATE TABLE recipes        (id TEXT PRIMARY KEY, title TEXT, description TEXT, body_yaml TEXT,
                             uses INTEGER, successes INTEGER);
CREATE TABLE schedules      (id TEXT PRIMARY KEY, cron TEXT, card_template JSON, origin_topic_id TEXT,
                             next_fire_at TEXT, active INTEGER);

-- Traces (milestone 0)
CREATE TABLE sessions       (id TEXT PRIMARY KEY, type TEXT /*worker|synthesis|desk|librarian|triage|planner|verifier|consolidator|router*/,
                             card_id TEXT, topic_id TEXT, desk_turn_id TEXT, model_profile TEXT,
                             steps INTEGER, outcome TEXT, started_at TEXT, ended_at TEXT);
CREATE TABLE tool_calls     (id TEXT PRIMARY KEY, session_id TEXT, llm_call_id TEXT /*the call that chose it*/,
                             step INTEGER, tool TEXT, args JSON, args_hash TEXT, deduplicated INTEGER,
                             result_text TEXT, result_artifact_id TEXT, exit_code INTEGER, ok INTEGER, ms INTEGER);
CREATE TABLE llm_calls      (id TEXT PRIMARY KEY, call_type TEXT, prompt_version TEXT, schema_version TEXT,
                             model_profile TEXT, provider TEXT, session_id TEXT, card_id TEXT, topic_id TEXT,
                             step INTEGER, attempt INTEGER, input JSON, raw_output TEXT, parsed JSON,
                             ok INTEGER, error TEXT /*timeout|parse|repetition|...*/, repaired JSON,
                             tokens_in INTEGER, tokens_out INTEGER, cost REAL, ms INTEGER, at TEXT,
                             eval_label JSON);

-- Memory
CREATE TABLE notes          (id TEXT PRIMARY KEY, kind TEXT, title TEXT, aliases JSON, one_liner TEXT,
                             body_rendered TEXT, project_id TEXT, tags JSON, dirty INTEGER DEFAULT 0, status TEXT);
CREATE TABLE claims         (id TEXT PRIMARY KEY, note_id TEXT, text TEXT, source JSON, observed_at TEXT,
                             volatility TEXT, status TEXT, superseded_by TEXT, confidence TEXT,
                             corroborations INTEGER DEFAULT 0);
CREATE TABLE facts          (id TEXT PRIMARY KEY, card_id TEXT, message_id TEXT, subject TEXT, text TEXT,
                             source JSON, volatility TEXT, status TEXT /*pending|merged|discarded|review*/,
                             decision TEXT, decision_analysis TEXT, target_claim_id TEXT, decided_at TEXT);

-- Search
CREATE VIRTUAL TABLE notes_fts    USING fts5(title, aliases, one_liner, body_rendered, content='notes');
CREATE VIRTUAL TABLE topics_fts   USING fts5(title, summary, content='topics');
CREATE VIRTUAL TABLE recipes_fts  USING fts5(title, description, content='recipes');
CREATE VIRTUAL TABLE episodic_fts USING fts5(kind, ref_id, text);
```

---

## 10. LLM gateway and call catalog

### 10.1 Gateway responsibilities

- One entry point: `call(call_type, inputs, *, profile=None, allowed=None) -> Parsed | Text`.
- Loads the versioned prompt template and schema (`prompts/<call_type>/v<N>.md`, `.schema.json`, `examples.jsonl`). Tool-result templates live in `prompts/tool_results/`.
- Applies **dynamic restrictions**: enum narrowing (`allowed`) and removal of options.
- **Output handling:**
  - Every call sets `max_tokens` (per call type, §10.3).
  - Local validation after every call, whatever the engine claims to enforce. Over-long strings are **truncated**, not rejected; missing optional keys get defaults; a missing required key or an invalid enum value is a parse error. Repairs are logged in `llm_calls.repaired`.
  - Profile quirk handling (§10.2).
- **Model-failure guards** (§11): streaming with an idle timeout, no resend after a timeout, repetition detection.
- **Retry policy:** one retry on a parse or repetition error, with the same input and lower temperature. No retry on timeout (§11). Then `LLMFailure`, which the caller maps to a state transition, never an unhandled exception.
- Concurrency slots and priorities per profile (§5.11).
- Logs every call to `llm_calls`, linked to its session, card, topic and step.

### 10.2 Model profiles and quirks

```yaml
profiles:
  small:
    base_url: http://localhost:8080/v1
    model: qwen-q4
    slots: 2
    reserve_interactive: 1
    thinking: off
    stream: true
    idle_timeout_s: 60
    quirks: [keys_alphabetical, unbounded_whitespace]   # discovered by the quirk probe
  bench:
    base_url: https://openrouter.ai/api/v1
    model: qwen/qwen3.6-35b-a3b
    thinking: off
    quirks: [keys_alphabetical, drops_newlines_in_strings, ignores_maxLength]
  large: null      # optional, for escalation and consolidation
  embed: null      # optional; see §19
  speech:
    base_url: http://localhost:8090/v1   # OpenAI-compatible /audio/transcriptions (whisper.cpp server or similar)
    model: whisper-small
    vocabulary_tokens: 200              # topic titles + entity note titles as the initial prompt
```

Known quirks and the gateway's response:

| Quirk | Gateway handling |
|---|---|
| `keys_alphabetical` | Nothing at runtime; schemas must be designed for it (P3). The schema linter checks that the reasoning key sorts first. |
| `unbounded_whitespace` | `max_tokens` plus a compact-JSON hint in the prompt; streaming whitespace watchdog (abort if >200 consecutive whitespace characters). |
| `ignores_maxLength` | Truncate during local validation. |
| `drops_required_keys` | Parse error → one retry. |
| `drops_newlines_in_strings` | Irrelevant by design: no long text inside JSON. |

A **quirk probe** script (`sandman probe <profile>`) runs a small fixed set of calls and reports which quirks apply. Run it for every new engine or quantization, followed by the benchmark.

### 10.3 Call catalog

`json` = constrained JSON; `text` = plain text. Token numbers are defaults for `max_tokens`.

| Call type | Used by | Format | Output | max_tokens |
|---|---|---|---|---|
| `segment_capture` | Capture | json | `{analysis, items: [{quote}]}` | 400 |
| `route_item` | Router | json | `{analysis, choice, confidence}` | 100 |
| `topic_title` | Router | json | `{title}` | 30 |
| `match_answer` | Needs-you, briefing | json | `{analysis, choice: <option enum> \| free_text}` | 80 |
| `topic_same` | Tidy-up | json | `{analysis, same: yes\|no}` | 80 |
| `desk_intent` | Desk | json | `{analysis, intent}` | 100 |
| `desk_args_new_work` | Desk | json | `{analysis, done_when[], goal, role, title}` | 300 |
| `desk_args_reminder` | Desk | json | `{text, when_text}` | 100 |
| `desk_args_answer` | Desk | json | `{question_id, response}` | 120 |
| `desk_args_add` | Desk | json | `{card_id, note}` | 150 |
| `desk_reply` | Desk | text | reply (conversation mode; capture mode only for `reply_only`) | 300 |
| `summarize_topic` | Desk | text | summary ≤150 words | 250 |
| `extract_owner_facts` | Desk | json | `{facts[]}` | 250 |
| `extract_entities` | Librarian | json | `{entities[]}` | 60 |
| `librarian` | Librarian | json | §7.6 | 200 |
| `render_answer` | Librarian | json | role result schema | 400 |
| `triage` | Dispatcher | json | `{analysis, fits, missing_info}` | 120 |
| `pick_recipe` | Planner | json | `{analysis, recipe_id}` | 100 |
| `plan_fill` | Planner | json | recipe params, `analysis` first | 200 |
| `plan_generate` | Planner | json | `{analysis, subtasks[≤5]}` | 450 |
| `worker_step` | Worker | json | action | 400 |
| `generate_content` | Worker tools | text | file or artifact body | per role (default 2000) |
| `summarize_artifact` | Harness | text | ≤30 words | 60 |
| `verify_criterion` | Verifier | json | `{analysis, verdict}` | 150 |
| `match_subject` | Consolidator | json | `{analysis, note_id}` | 100 |
| `relevance_rubric` | Consolidator | json | `{analysis, costly, reusable, task_mechanics, trivial}` | 120 |
| `consolidate_fact` | Consolidator | json | `{analysis, decision, target_claim_id}` | 120 |
| `render_brief` / `render_note` | Consolidator | text | markdown | 700 |
| `generalize_recipe` | Recipes | text | YAML draft (owner reviews) | 500 |

Speech-to-text runs on the `speech` profile and is traced like an LLM call (`call_type = transcribe`).

### 10.4 Prompt and schema rules

1. **Alphabetical order = generation order.** Every classification (verdicts, decisions, intents, rubric booleans, volatility) is preceded by an `analysis` field (≤40 words). More generally, key names are chosen so that alphabetical order matches the intended generation order: reasoning before decisions, selectors (IDs, enums) before the content that depends on them (`question_id` before `response`, `tool` before `tool_args`). A schema linter enforces this (P3).
2. **Describe every option.** Every enum value (roles, intents, recipes, topics, questions, cards) is listed in the prompt with a one-line description. The schema enum alone is not enough.
3. **Static first, question last.** Order: fixed preamble → tool/option descriptions → stable context (profile, card, brief) → dynamic context → the question. The static prefix enables prompt caching on local servers.
4. **One to three short examples** for every classification call.
5. **Don't instruct what the grammar enforces;** enforce instead.
6. **Always inject** the current date, time and the owner's timezone into calls that involve time.
7. **Tool results are prompts** (P13): they state what happened and what to do next. They are versioned and evaluated.
8. **Long text only in `text` calls.**
9. **Judge criteria describe only what the judge sees** (§5.8).

---

## 11. Guards against model failure modes

These guards are mandatory.

| Failure | Guard | Observed in benchmarks |
|---|---|---|
| **Loops:** the same tool call repeated | Tool calls are hashed on (tool, normalized args). An identical call in the same session is **not re-executed**; the result is the template "You already did this in step k; its result is above. Choose a different action." Recorded as `deduplicated`. The third consecutive duplicate ends the session as `fail(tool_error)`. | Identical searches repeated 5× |
| **Repetition collapse:** degenerate, highly repetitive output | For outputs over 500 characters, measure repetition (e.g. the compression ratio, or the share of repeated 8-grams). Above the threshold, the output is invalid (`error=repetition`) and retried once at a different temperature. | A 12,000-character repeated `import` line |
| **Invisible results:** facts beyond a truncation point | Tool results over `tool_result_window` (default 2500 characters) are saved as artifacts and paged. The **position header comes first**: `[characters 0–2500 of 6106 from <source>. Continue with read_artifact(art_x, 2500).]` | Facts past the first 3000 characters of a page were never seen |
| **Endless whitespace / hanging calls** | `max_tokens` on every call; whitespace watchdog; streaming with an **idle timeout** (no token for `idle_timeout_s`) instead of a total timeout. | Engines emitting whitespace until timeout |
| **Duplicate generation after timeout** | A timed-out request to a local server is **cancelled and marked failed** (the server may still be generating, and a second request would queue a second job). The card-level retry policy decides what happens next. | — |
| **Confident false claims about actions** | P12: receipts and harness-recorded facts; no action-report fields in schemas. | "Reminder sent", "tests passed" |
| **Ending without doing the second half** | Desk intent loop plus tool-result wording (§6.6). | "Research X and remind me Friday" lost the reminder |
| **Answering the wrong question** | `answer_question` offered once per turn; enum only of open questions. | Second question "answered" with "Not specified" |
| **Invented or merged capture items** | Segmenter items must quote the transcript; quotes are verified by fuzzy match, and non-matching items are dropped. Uncovered text becomes an `unfiled_text` review item. | — |
| **Misheard speech** | Vocabulary prompt from topic and note titles; every receipt has undo; side effects always need approval (§6.7). | — |

---

## 12. Safety, permissions and side effects

- **Tool risk classes:** `read` (search, fetch, read files), `write-local` (workspace files), `side-effect` (anything outside the workspace: sending mail, posting, purchasing, modifying external systems, deleting).
- `side-effect` tool calls become an `approval` question in the needs-you list ("Card *X* wants to …: 1 approve, 2 reject"), unless a config allow-rule matches. From a capture, they always go through approval (§6.7).
- No v5 role has side-effect tools. An `ops` role, when added, can only be created by the desk on explicit owner instruction.
- Secrets stay in config/env, are injected into tool implementations, and never appear in prompts, traces or artifacts. The trace store redacts known secret patterns.
- API: one bearer token per client, stored hashed; bound to localhost or a private network by default; TLS when exposed.
- Fetched web content is data. It goes in delimited blocks, and nothing in a tool result can change a card's toolset, budget or permissions.

---

## 13. State failure modes and mitigations

(Model failure modes: §11.)

| Failure | Detection | Mitigation |
|---|---|---|
| Misrouted capture item | Owner uses Move; `filing_check` review items | One-click move, re-parenting of cards and reminders, routing examples added to evals |
| Wrong action from a capture | Receipts in the confirmation | Undo on every receipt (§6.7) |
| Topic sprawl (many small or duplicate topics) | Nightly tidy-up | Merge and project suggestions; automatic archive with undo (§6.11) |
| Card explosion | Calls-per-tree budget, depth 1, ≤5 children | Refuse; block to owner |
| Worker never finishes | Step budget | Last step allows only terminal actions |
| Verifier too strict or lenient | Owner feedback; eval set | Reasoning-first per-criterion judges with harness facts; criteria authoring rules |
| Summary drift | Periodic rebuild | Rebuild from source (§6.5, §7.7) |
| Memory pollution | Owner review, fact deletion on topic pages | Rubric, subject rule, provenance, retraction list |
| Stale memory used as truth | Claim age (code) | Stale notes not answerable; `[as of]` markers; narrow path |
| Owner waits behind workers | Queue latency metrics | Interactive slot reservation; `desk.working` events |
| Model or speech server down | Gateway transport errors | Cards stay `ready`; captures stay `received` and are retried; `system` message; backoff |
| Crash mid-session | Expired lease | Reclaim → `ready`; transcript retained |
| Questions unseen | Open-question age | Ranked needs-you list; nag once; briefings; Web Push (§6.9, §6.12) |
| Too many interruptions | Push count per day | Interrupt budget; overflow goes to badges and the next briefing (§6.12) |
| Prompt injection via web content | — | Harness-owned permissions; side-effect approvals |

---

## 14. Observability, UI and evaluation

### 14.1 Tracing (milestone 0)

- `sessions`, `tool_calls` and `llm_calls` tables from day one, all linked: every tool call references the LLM call that chose it; every call records session, card, topic, step, attempt, schema version, provider, tokens, cost and latency.
- **Inspection UI before the chat UI.** A read-only web view with:
  - **Session timeline:** each step with the prompt (collapsible), raw output, parsed action, tool result, and flags (repaired, deduplicated, timeout).
  - **Card detail:** contract, state timeline, sessions, comments, result, harness-recorded facts, verifier analyses.
  - **Call detail:** full input and output; "label correct/incorrect"; "add to eval set".
  - **Desk turn view:** input (message or capture item) → intents → arguments → receipts → reply.
  - **Capture view:** audio → transcript → segmenter items (with quote-match scores and uncovered text) → routing per item (candidates shown, choice, confidence) → desk turns → confirmation.

### 14.2 Owner UI (a client, built after the inspection UI)

- **Capture:** one button for a voice memo, one text field, and share-sheet support; the confirmation shown with undo on each receipt. The phone client speaks the confirmation in `driving` mode.
- **Needs you:** the ranked question list with option buttons and free-text or voice answers; a "Brief me" button.
- **Topics:** a topic list with unread badges; each topic page as in §6.5, with fact editing and a message box for conversation mode.
- **Review:** filing checks, unfiled text and tidy-up suggestions, each with its one-tap actions.
- **Board:** columns by state, filterable by topic, with comment, cancel and retry.
- **Memory browser:** claims with provenance, retract and edit.

### 14.3 Evaluation

- **Golden sets per call type** (`evals/calls/<call_type>.jsonl`): useful for regressions, but they saturate quickly (95%+).
- **Harness suite** (`evals/episodes/`): short episodes and whole card trees run through the real harness against a **fixed offline corpus** (cached search results and pages), so runs are reproducible. It covers long pages, saved files, follow-ups (`add_to_card`), multi-subject captures (segmentation plus routing plus actions), reminders, question answering (buttons, free text, briefing), undo, memory reuse, and compare trees. Voice episodes use **stored transcripts, including realistic transcription errors**, so they don't depend on the speech model.
- **Noise:** run-to-run variation is about ±3 points. Compare prompt or harness versions over **≥3 independent runs, pooled**, preferably on different days or providers; repeats within one run understate the variance.
- **Sensitive list:** cases that have ever failed form a cheap smoke suite.
- **Judges are literal:** eval criteria describe only what the judge sees.
- **Grow cases from traces:** the inspection UI's "add to eval set" is the main source. Hand-written seeds overfit to the prompts written alongside them.
- `sandman eval calls <call_type>` and `sandman eval episodes [--suite sensitive]` report accuracy, parse/repair rates, calls, output tokens and latency.

---

## 15. Budgets and latency

**Measured:** calls are small: 100–800 input tokens and 10–100 output tokens (worker steps average ~540 in / ~90 out; `plan_generate` ~380 out). A "compare three kits" tree is ~20 calls, ~21k input and ~2.3k output tokens. At an assumed 200 tokens/s prompt processing and 15 tokens/s generation, that is about 4–5 minutes on a local model.

Therefore:

- **Budget in calls and output tokens, not context.** Per card: `steps` and `output_tokens`. Per root tree: `max_llm_calls` (default 40). Context-slot caps (§17) remain as safety limits only.
- **Static-first prompts** (§10.4 rule 3) so a local server can reuse the prefix across steps of a session and across cards of the same role. Measure the cache hit rate in M6.
- **Latency budget for the desk:** in conversation mode, intent + arguments + reply is typically 3 small calls, about 20–40 s on a slow local model. The UI shows `desk.working` immediately, and receipts appear before the reply text.
- **Latency of a capture:** transcription (seconds) + 1 segmentation call + per item 1 routing call (+1 for a new topic's title) + 2 desk calls per action. A three-item memo is about 10 calls, roughly a minute on a slow local model. Nothing waits on the owner in the meantime, and the spoken confirmation arrives when all items are handled. Capture mode saves one `desk_reply` per item.
- **Briefings** cost no model calls per answer unless `match_answer` is needed, so they stay responsive even while workers occupy the model.
- Output-heavy calls (`generate_content`, `render_brief`) are the ones to watch. Cap them per role.

---

## 16. Implementation plan (milestones)

Repository layout (suggested):

```
sandman/
  core/          db.py, ids.py, config.py, events.py
  llm/           gateway.py, profiles.py, quirks.py, guards.py, schemas.py, schema_lint.py
  prompts/       <call_type>/vN.md, vN.schema.json, examples.jsonl; tool_results/*.md
  work/          board.py, dispatcher.py, librarian.py, triage.py, planner.py, worker.py,
                 verifier.py, scheduler.py, roles/, recipes/
  conversation/  api.py, events.py, capture.py, transcribe.py, segment.py, router.py, desk.py,
                 receipts.py, pages.py, questions.py, briefing.py, review.py, tidy.py, notifier.py
  memory/        facts.py, consolidator.py, retriever.py, notes.py, render.py
  tools/         web.py, artifacts.py, files.py, sandbox.py
  inspect/       inspection UI (read-only)
  evals/         calls/, episodes/, corpus/, runner.py
  docs/          DESIGN.md, DEVIATIONS.md
```

### M0 — Foundations and tracing
- DB schema and migrations, IDs, config.
- Gateway: schemas, local validation and truncation, `max_tokens`, streaming with idle timeout, no resend, repetition guard, quirk handling, schema linter, `sandman probe`.
- `sessions`, `tool_calls`, `llm_calls` with full linking; **inspection UI** (read-only).
- Eval runner for call sets and episodes; fixed offline corpus.
- **Accept:** (1) the probe reports quirks for two engines; (2) the linter rejects a schema whose decision key sorts before `analysis`; (3) any session can be viewed step by step in the inspection UI.

### M1 — Board and workers
- Cards, deps, events, comments; state machine (§5.3) as one tested module; dispatcher, leases, recovery.
- Worker loop with `finish` / `block` / `fail`, applicability filtering, last-step rule, static-first context pack.
- Roles `research`, `write`, `synthesize`; `generate_content` two-step writes; paging of long results; duplicate-call guard; harness-recorded facts.
- **Accept:** (1) a research card whose answer sits past character 3000 of a page finds it via paging; (2) a `write` card produces a multi-paragraph file with intact newlines; (3) killing the process mid-session and restarting completes the card; (4) a repeated identical search is not re-executed.

### M2 — Decomposition and verification
- Librarian stub (proceed only), triage (`fits` + `missing_info`), `pick_recipe`, `plan_fill` with quoted criteria, `plan_generate`, fan-out via `items[]`, parent synthesis.
- Verifier (reasoning-first judges with harness facts), retry and escalation, calls-per-tree budget.
- Seed recipes: `rcp_research_detail` and one writing recipe.
- **Accept:** (1) "compare three kits" yields gather → 3 detail → synthesis, with no duplicate compare step; (2) a simple lookup is not split; (3) planner children are never split; (4) a failing criterion causes one retry with the judge's analysis as a comment, then escalation.

### M3 — API, capture and topics (text first)
- API and event log (Appendix B), client tokens, SSE, cursor sync, idempotent posts.
- Text capture: merging, `segment_capture` with quote verification and coverage check, `route_item` per item, `topic_title`, provisional filings, Move with re-parenting.
- Desk in capture and conversation mode: intent → args → reply rule; receipts with undo; tools only when applicable; decision point vs. single loop. Capture confirmations (text and speech form).
- Topic pages (§6.5) with fact editing; typing debounce on topic pages.
- Needs-you list: ranking, voice-ready question format, answer paths, code matching + `match_answer`; approvals.
- Reminders; schedules; notifier with quiet hours, interrupt budget, client modes and Web Push; `card_result` messages.
- Review pile for `filing_check` and `unfiled_text`; automatic archiving with undo.
- A minimal owner UI: capture field, needs-you list, topic pages, review list.
- **Accept:** (1) the typed capture "garden: the kit must also reach the balcony pots, remind me Friday to file the tax extension, and find out if the bike shop repairs e-bikes" becomes 3 items in 3 topics with 3 correct actions and one confirmation that names all three; (2) "remind me…" never creates a work card; (3) a capture that names a topic ("Garden: …") is routed to it by `route_item`; (4) undoing a "new card" receipt cancels the card; (5) with two open questions, answering one leaves the other open, and "the first one" is matched without a model call; (6) a follow-up on a running card reaches the worker's next step; (7) moving an item re-parents its card and reminder; (8) two clients show identical histories after one reconnects.

### M4 — Memory
- Facts (subject rule), owner-fact extraction, negative facts; consolidator on schedule and idle with the 4-question rubric and contradiction questions.
- Librarian with code-computed staleness, `answered` / `narrow` / `proceed`, `render_answer`.
- Profile note; projects and briefs; retraction.
- **Accept:** (1) a question about something researched a week earlier is `answered` with zero worker steps; (2) a stale price is `narrow`ed to a price check; (3) duplicate facts from synthesis become corroborations; (4) an owner preference appears in the profile after the nightly run without manual action.

### M5 — Voice, briefings and tidy-up
- Audio captures: `speech` profile, vocabulary prompt from topic and note titles, audio kept as artifacts.
- Briefings: script assembly, the harness dialogue state machine, `skip` / `repeat` / `stop`, `driving` mode start; spoken forms of confirmations and prompts.
- Nightly tidy-up: merge candidates with `topic_same`, project suggestions, archive notices; `topic_merge` accept path (moves messages, cards and questions; slug alias).
- **Accept:** (1) a recorded three-item voice memo from the eval set produces the same items and topics as its text version; (2) a briefing with three questions is completed by voice with at most one model call; (3) two topics about the same thing produce a merge suggestion, and accepting it leaves no orphaned cards or questions.

### M6 — Local model hardening
- Rerun the full harness suite on the target local Q3/Q4 model via llama.cpp; update the quirk lists.
- Measure single-slot latency, interactive reservation and priorities; prompt-cache hit rate; end-to-end capture latency.
- `code` role with sandbox; crash-recovery tests under real process kills; recipe promotion flow.
- **Accept:** a documented comparison (OpenRouter baseline vs. local Q4) over ≥3 pooled runs, with a list of prompt and harness changes needed for the local model.

---

## 17. Configuration (defaults)

```yaml
owner: {name: "…", timezone: Europe/Zurich, quiet_hours: "22:30-07:30"}
api: {bind: 127.0.0.1:8700, sse: true}
capture: {merge_seconds: 10, segment_min_words: 30, quote_match_min: 0.9,
          unfiled_min_words: 8, audio_days: 7}
router: {recent_candidates: 6, fts_candidates: 3}
topic_page: {debounce_quiet_seconds: 4, debounce_max_seconds: 60}
desk: {max_actions: 3, history_messages: 8, report_mode: structured, summary_rebuild_every: 20}
undo: {window_hours: 24}                      # or until the effect is consumed
needs_you: {max_question_words: 25, max_options: 4, max_option_words: 6, nag_hours: 24}
briefing: {at: "07:30", start_on_driving: true}
tidy: {at: "after_consolidation", merge_similarity: 0.6, project_card_threshold: 6, archive_after_days: 14}
notifier:
  levels: {question: push, approval: push, reminder: push, card_result: badge, desk_reply: badge,
           receipt: silent, review: silent}
  max_push_per_day: 6
board: {max_children: 5, max_attempts: 2, max_llm_calls_per_tree: 40, lease_seconds: 300}
triage: {compare_split_threshold: null}      # open question 1
roles:
  research:   {steps: 10, output_tokens: 1500, tools: [web_search, web_fetch, read_artifact]}
  write:      {steps: 6,  output_tokens: 3000, tools: [read_artifact, write_artifact]}
  synthesize: {steps: 6,  output_tokens: 3000, tools: [read_artifact, write_artifact]}
  code:       {steps: 15, output_tokens: 6000, tools: [list_dir, read_file, write_file, run]}
tool_result_window: 2500
guards: {repetition_min_chars: 500, max_duplicate_calls: 2, whitespace_run_limit: 200}
context_caps: {profile: 300, brief: 600, notes: 1200, inputs: 1500, comments: 500}   # safety caps only
memory:
  volatility_max_age_days: {volatile: 7, slow: 180, evergreen: null}
  librarian: {skip_roles: [code], top_k: 6}
  consolidator: {at: "03:00", min_pending: 20, profile: small}
```

---

## 18. End-to-end walkthrough

The owner is driving. Tuesday 08:14.

1. **Capture.** The owner taps the capture button on the phone and says: "Garden: the drip kit also needs to reach the two balcony pots. Uh, and remind me Friday to file the tax extension. Oh, and can you find out if the bike shop near the station repairs e-bikes." The app posts the audio (`POST /captures {audio, source: voice}`); the phone is in `driving` mode.
2. **Transcribe.** The `speech` profile transcribes it, with topic titles ("Raised bed irrigation", "Taxes 2026", …) and note titles ("Gardena Micro-Drip starter set", …) as vocabulary.
3. **Segment.** `segment_capture` returns 3 items, each quoting its span. All 3 quotes match the transcript; the uncovered words ("Uh, and", "Oh, and") are below the unfiled threshold.
4. **Route.**
   - Item 1: `route_item` sees the explicitly named "Garden" and chooses `irrigation` (high).
   - Item 2 → `taxes` (high).
   - Item 3: no candidate fits → `new`; `topic_title` → "E-bike repair" (slug `ebike-repair`).
5. **Desk, capture mode.**
   - Item 1: `add_to_card` on the running "Compare drip kits" card → comment → receipt.
   - Item 2: `reminder` → `{text: "File the tax extension", when_text: "Friday"}`, parsed as Fri 2 Oct 09:00 Europe/Zurich → receipt.
   - Item 3: `new_work` → a research card "Does the bike shop near the station repair e-bikes?" → receipt.
   - No `desk_reply` calls (none of the items was a question).
6. **Confirm.** The harness builds the confirmation from the three receipts. The phone speaks: "Got it, three items. Added to drip kits. Reminder for Friday, 9:00. New topic: e-bike repair." Each receipt shows an undo on screen. Total: 10 model calls.
7. **Work.** The "Compare drip kits" worker sees the balcony comment at its next step. For the new card: librarian (nothing known) → triage `fits: yes` → worker → verifier. For the drip kits: the gather step found 3 kits and the harness fanned out 3 `detail` cards. One page is long; its price sits at character 4,100 and is found via `read_artifact(art_x, 2500)`.
8. **Blocked.** Kit C's detail card can't find water-use figures and blocks: "Kit C doesn't publish its water use. 1: use the forum estimate, 2: leave it out." The question tops the needs-you list, because the comparison waits on it, and pushes (the first push today).
9. **Briefing.** On the drive home the phone switches to `driving` mode and starts a briefing. The owner answers "one" (code match), "the one from last year, I guess" for the accountant question (`match_answer`), and "skip" for a memory conflict. Two cards resume.
10. **Synthesis and report.** The parent (`phase=synthesize`) writes `comparison.md` via `write_artifact` (two-step, plain text) and finishes with a recommendation. The verifier sees the result **and** the harness record "wrote comparison.md (410 words)" → pass. A `card_result` message appears on the `irrigation` topic page (`notify: badge`).
11. **Night.** The consolidator creates 3 entity notes (prices `volatile`, specs `slow`); "must reach the balcony pots" becomes an owner-sourced claim on the topic page. The tidy-up job notices `ebike-repair` and an older `bike` topic and proposes a merge (review item).
12. **Two weeks later.** A capture: "What did the Gardena kit cost again?" Routing → `irrigation`; the desk intent is `new_work`. The librarian finds the note, but the price claim is 14 days old (`volatile` → stale, not answerable) → `narrow`: "Check the current price of the Gardena Micro-Drip starter set (last seen CHF 89 on 29 Sep)". A 2-step card instead of a research tree.

---

## 19. Open questions and what hasn't been tested

**Design questions**

1. **Compare rule.** Should "compare N named things" always go to a recipe via a code rule (`compare_split_threshold`), or should the model's `fits` answer be trusted? In the benchmark, the remaining triage misses were compare tasks the model judged to fit in one session, which is arguably true.
2. **Desk structure.** Intent split vs. a single tool loop (§6.6 decision point, M3).
3. **Embeddings.** Do vectors add enough over FTS plus exact entity match at personal scale? Measure in M4 before depending on them.
4. **Items that span two topics.** The segmenter splits by subject, so "research X and remind me about taxes" becomes two items. A single sentence that genuinely touches two topics still lands in one. Evaluate on real captures before adding anything.
5. **Refresh cards.** Dropped in favour of `narrow`. Revisit if stale knowledge causes wrong answers in practice.
6. **Push delivery** when no client is open: Web Push, ntfy, or the local app's own mechanism.
7. **A stronger model part-time** for consolidation and escalation: what may leave the machine?
8. **Topic splits.** The tidy-up job can merge but not split a topic that has drifted into two subjects. Add a `topic_drift` check if merging alone leaves messy topics.
9. **Follow-up captures.** A capture that answers something Sandman just said ("yes, do that") has no reply link. The router will usually file it correctly, but the desk sees it as a capture item. Decide whether capture mode should include the topic's last Sandman message as extra context.
10. **Briefing interruptions.** What happens when a new push-worthy question arrives mid-briefing: append it to the script, or hold it for the next briefing?

**Not yet tested**

- A local quantized model. All numbers come from qwen3.6-35b-a3b on OpenRouter at near-full precision. Q3/Q4 on llama.cpp may be noticeably worse, and its grammar engine behaves differently. **Rerun the benchmark before trusting any number here (M6).**
- Latency under one slot, the interactive reservation, and priorities.
- Projects and briefs, embeddings, the code sandbox, and crash recovery under real crashes.
- Long-term memory at scale (thousands of notes; drift over months).
- The capture pipeline end to end: segmentation of real (messy) transcripts, `route_item` accuracy on captures, undo semantics, briefings, and tidy-up suggestions.

---

## Appendix A — Example prompts (starting points; version and evaluate)

### A.1 `triage` (v1)

```
You decide whether a task can be completed in ONE work session.

A session has at most {steps} steps and these tools:
{tool_lines}            # "- web_search: search the web; returns titles and snippets"

Task: {title}
Goal: {goal}
Done when:
{done_when_lines}

For context, these multi-step plans exist (you are NOT choosing one now):
{recipe_titles}

Examples:
- "Find the opening hours of the Zurich botanical garden" → fits: yes
- "Compare 4 health insurers on price and coverage and recommend one" → fits: no
- "Book a table for my birthday" (no date or place given) → missing_info: "Which date and which restaurant or area?"

Reply with:
- analysis: one or two sentences
- fits: yes or no
- missing_info: a short question for the owner ONLY if the task cannot start without it, else null
```

### A.2 `desk_intent` (v1)

```
You are Sandman's front desk for the topic "{topic_title}". Decide the NEXT action for what the owner said.

Actions:
- new_work: the owner wants something researched, written, compared or built
- reminder: the owner wants to be reminded at a time
- answer_question: the owner is answering one of the open questions below          {only if open questions}
- add_to_card: the owner adds a requirement or detail to an existing card below     {only if open/recent cards}
- reply_only: a question or remark you can answer directly from the context
- nothing: no action and no reply needed (e.g. "thanks")
{on later passes: "- done: everything has been handled" instead of reply_only/nothing}

Open cards: {card_lines}
Open questions: {question_lines}
Done so far this turn: {receipts}

{capture mode:}
The owner said this in a voice memo or quick note (it may contain transcription errors):
"{item_quote}"
Full memo, for context only; other parts are handled separately:
"{transcript}"
{conversation mode:}
Owner's message:
"{message}"

Reply with analysis (one sentence), then intent.
```

### A.3 `verify_criterion` (v1)

```
Check ONE criterion against a work result. Judge only what is shown below.

Criterion: "{criterion}"

Result:
{summary}
{items}
{recommendation}

Recorded by the system (reliable):
{harness_facts}        # e.g. "Wrote comparison.md (410 words)", "Last command: pytest → exit code 1"

{artifact_excerpts}

Reply with analysis (≤40 words), then verdict: pass or fail.
```

### A.4 `relevance_rubric` (v1)

```
A work session produced this candidate fact:
Subject: {subject}
Fact: "{claim}"
Source: {source_type}
From the task: "{card_title}"

Reply with analysis (one sentence), then true or false for each:
costly: Would finding this again take real effort (research or asking the owner)?
reusable: Could a DIFFERENT future task plausibly need this fact?
task_mechanics: Is this only about how this task was carried out (tools used, steps taken)?
trivial: Is this common knowledge that any assistant already knows?
```

### A.5 Tool-result templates (v1)

```
create_card   → "Created card \"{title}\". Is there anything else here that still needs an action?"
remind        → "Reminder set for {weekday} {date}, {time} ({timezone}). Is there anything else here that still needs an action?"
web_fetch     → "[characters {a}–{b} of {n} from {url}. Continue with read_artifact({art}, {b}) if you need more.]\n{text}"
duplicate     → "You already did exactly this in step {k}; its result is above. Choose a different action."
write_artifact→ "Saved {name} ({words} words)."
run           → "Command finished with exit code {code}. Last lines:\n{tail}"
```

### A.6 `segment_capture` (v1)

```
The owner recorded a voice memo or wrote a quick note. It may contain several unrelated requests or
remarks, and may contain transcription errors.

Split it into separate items. An item is one thing the owner wants done, wants remembered, or asks.
For each item, copy its words EXACTLY from the text (quote). Don't rephrase and don't combine two
subjects into one item. Leave out filler ("uh", "oh and").

Text:
"{transcript}"

Example:
"Remind me to call the plumber tomorrow and also what was the name of that tile shop"
→ items: [{quote: "Remind me to call the plumber tomorrow"},
          {quote: "what was the name of that tile shop"}]

Reply with analysis (one sentence), then items.
```

### A.7 `route_item` (v1)

```
Decide which topic this item belongs to.

Item (from a voice memo or quick note, may contain transcription errors):
"{item_quote}"

Topics:
{candidate_lines}        # "- irrigation: Raised bed irrigation. Comparing three drip kits for the beds."
- new: none of these topics fits; this starts a new subject

If the owner names a topic explicitly (e.g. "Garden: …"), choose the topic that name refers to.
Choose `new` only if no topic is about the same subject.

Reply with analysis (one sentence), then choice, then confidence: high if clearly right, low if you're unsure.
```

---

## Appendix B — Unified API (v1 sketch)

All endpoints require `Authorization: Bearer <client token>`. JSON in, JSON out.

| Method | Path | Purpose |
|---|---|---|
| GET | `/events?after=<id>` / SSE `/events/stream?after=<id>` | Sync and live updates |
| POST | `/captures` `{text? \| audio?, url?, source, client_msg_id}` | Quick capture (idempotent); returns the capture id |
| GET | `/captures/{id}` | Transcript, items, routing, receipts, confirmation |
| POST | `/items/{id}/move` `{topic_id \| "new"}` | Correct a filing (re-parents cards and reminders) |
| POST | `/receipts/{id}/undo` | Undo an action |
| GET | `/topics?status=active\|archived` | Topic list with unread counts |
| PATCH | `/topics/{id}` | Rename, archive, unarchive (topics are only created by capture routing) |
| GET | `/topics/{id}/page` | Topic page (§6.5) |
| GET | `/topics/{id}/messages?before=<msg_id>&limit=` | Conversation history |
| POST | `/messages` `{topic_id, text, client_msg_id}` | Conversation-mode message on a topic page (topic required) |
| POST | `/typing` `{topic_id}` | Debounce hint on a topic page |
| GET | `/needs-you` | Ranked open questions across topics |
| POST | `/questions/{id}/answer` `{option? \| text? \| audio?}` | Answer (code match first, then `match_answer`) |
| POST | `/briefings` · `/briefings/{id}/reply` `{text? \| audio?}` | Start a briefing / answer the current prompt; returns `{text, speech}` |
| GET | `/review` · POST `/review/{id}/{action}` | Review pile and its actions |
| PATCH/DELETE | `/topics/{id}/facts/{claim_id}` | Edit or delete a fact line (owner-sourced memory change) |
| GET | `/cards?topic_id=&state=` · `/cards/{id}` | Board and card detail (incl. harness facts) |
| POST | `/cards` `{topic_id, title, goal, done_when, role}` | Owner-created root card (from the board UI) |
| POST | `/cards/{id}/comment` · `/cancel` · `/retry` | Card actions |
| GET | `/artifacts/{id}` | Download artifact |
| GET | `/memory/notes?query=` · `/memory/notes/{id}` | Memory browser |
| POST | `/memory/retract` `{note_id? , claim_id?}` | Retract |
| POST | `/memory/consolidate` | Manual consolidation (+ tidy-up) run |
| POST | `/presence` `{mode: active\|driving\|dnd, topic_id?}` | Client mode (notifier, briefings) |
| POST | `/quiet` `{until}` | Quiet mode |
| POST | `/push-subscriptions` | Register Web Push |
| GET | `/inspect/sessions/{id}` · `/inspect/calls/{id}` · `/inspect/cards/{id}/timeline` · `/inspect/captures/{id}` | Inspection (read-only) |
| POST | `/inspect/calls/{id}/label` | Label for evals |

Event payloads carry enough for rendering without extra requests (e.g. `message.created` includes the full message).

---

*End of design document.*
