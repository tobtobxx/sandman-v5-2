# Client API (chat-first client)

Shaped by the screens of the chat-first client: Home (prompt), Send result (several items),
Topic (chat history), plus Needs you, Review, Board and Memory. JSON in, JSON out. Live updates
come from the event stream; clients re-fetch the view an event touches.

The observer UI uses the `/inspect/*` routes and a few read routes below; they are not listed here.

## Sidebar and home

### `GET /topics`
Sidebar list, most recently active first. Conversation topics are included.
```json
[{ "id": "top_…", "title": "Raised bed irrigation", "kind": "subject" | "conversation",
   "open_questions": 1, "open_cards": 1, "is_new": true, "last_activity_at": "…" }]
```
`is_new`: created in the last hour and not opened yet.

`GET /topics?status=archived` lists only archived topics; `?status=all` lists every topic (the
client's All topics view) and each row also carries `status`, `summary` and `archived_at`.

### `POST /topics/:id/unarchive`
Makes an archived topic active again and restarts its archive timer (`last_activity_at` = now).

### `GET /home`
```json
{ "now": "Tuesday 29 September · 08:14",
  "needs_you": [{ "id": "qst_…", "text": "…", "topic_id": "top_…", "topic_title": "…" }],   // ranked, ≤ 5
  "finished":  [{ "card_id": "crd_…", "title": "…", "summary": "…", "topic_id": "…", "topic_title": "…" }], // last 24 h, ≤ 5
  "needs_you_count": 2, "review_count": 1 }
```

## Sending from home

### `POST /send` `{ text, client_msg_id }`
Splits the message into items and files each into a topic, then returns. The desk handles the
items in the background; its receipts and replies arrive as events.
```json
{ "send_id": "cap_…",
  "items": [{ "item_id": "itm_…", "quote": "…", "topic_id": "top_…", "topic_title": "…",
              "topic_kind": "subject" | "conversation", "created": true, "confidence": "high" }] }
```
The client navigates: one item → `#topic/<topic_id>`; several → `#send/<send_id>`.

If filing fails (the model can't be reached), the message is kept and retried in the background with
backoff, and the reply is `{ "send_id": "cap_…", "pending": true, "items": [] }`; the client shows
`#send/<send_id>`, which fills in once `send.filed` arrives. Resending with the same `client_msg_id`
joins or restarts the same send, it never files the text twice.
Chit-chat and general questions ("hi", "brief me") are filed into a new conversation topic.

### `GET /sends/:id`
The send-result screen.
```json
{ "send_id": "cap_…", "text": "…", "state": "pending" | "filed" | "handled",
  "items": [{ "item_id", "quote", "topic_id", "topic_title", "topic_kind", "created",
              "receipts": [{ "id", "kind", "text", "undone": false }], "reply": "…" | null }] }
```

## Topic (chat)

### `GET /topics/:id`
Everything the chat screen draws, in one call. Opening a topic marks it seen.
```json
{ "topic": { "id", "title", "kind", "summary", "created_at" },
  "chips": { "cards": [{ "id", "title", "state" }], "open_questions": 1, "facts": 3 },
  "working": false,
  "timeline": [
    { "type": "day", "label": "Today" },
    { "type": "owner", "id": "msg_…", "text": "…", "at": "…", "from_home": true, "item_id": "itm_…", "siblings": 2 },
    { "type": "reply", "id": "msg_…", "text": "…", "at": "…" },
    { "type": "receipt", "id": "rcp_…", "text": "…", "undone": false, "card": { "id", "title", "state", "progress": "3 of 4 parts done" } | null },
    { "type": "question", "id": "qst_…", "card_id": "crd_…" | null, "text": "…", "options": ["…"], "details": { "why": ["…"], "result": "…" | null } | null, "status": "open" | "answered", "answer": "…" | null },
    { "type": "result", "card_id": "…", "title": "…", "state": "done", "summary": "…", "recommendation": "…" | null, "artifacts": [{ "id", "name" }], "at": "…" },
    { "type": "reminder", "text": "…", "at": "…" },
    { "type": "system", "text": "…", "at": "…" }
  ] }
```

A question's `details` say why it is asked. For a stuck card: `why` lists what went wrong (for a failed
verification, each failed check with the verifier's reason) and `result` is the card's latest result summary.
`GET /needs-you` returns the same `details` on each question.

### `POST /topics/:id/messages` `{ text, client_msg_id }`
A message typed in the topic's chat goes straight to that topic (no splitting, no routing).
Returns `{ message_id }`; the desk's receipts and reply arrive as events.

## Actions

| Route | Body | Effect |
|---|---|---|
| `POST /receipts/:id/undo` | — | Undo an action; returns `{ ok, note }` |
| `POST /items/:id/move` | `{ topic_id }` or `{ topic_id: "new" }` | Re-file an item with its cards and reminders; returns the target topic |
| `POST /questions/:id/answer` | `{ option: <index> }` or `{ text }` | Answer; the card resumes |
| `POST /cards/:id/cancel` · `/retry` · `/comment {text}` | | Card actions (board) |
| `POST /briefings` · `/briefings/:id/reply {text}` | | Scripted briefing (kept for voice) |
| `POST /presence` | `{ topic_id }` | The topic on screen (its events are not pushed) |

## Secondary views (unchanged)

`GET /needs-you`, `GET /review` + `POST /review/:id/:action`, `GET /cards?state=`,
`GET /cards/:id` (the client's card details dialog; also the observer), `GET /artifacts/:id`, `GET /memory/notes?query=`, `POST /memory/retract`,
`POST /memory/consolidate`, `PATCH|DELETE /topics/:id/facts/:claim`.

Memory details:
- `GET /memory/notes?query=` runs the memory search the librarian, workers and desk use (`findNotes` in
  `src/memory/retriever.ts`) and returns exactly what they would get for that text, best first, at most
  `memory.top_k` (6): active notes, plus candidate facts still waiting for the consolidator, grouped by
  subject, as `{ kind: "fact", status: "pending", claims: [{ pending: true, … }] }`. The ranking fuses an
  exact title/alias match, FTS words and, when the `embedding` role has a model, similarity of meaning
  (config.default.jsonc). Without `query` it lists every note (retracted and the profile too), newest
  first, then every pending fact.
- `POST /memory/consolidate` starts a run in the background and returns at once with
  `{ started, running, started_at, last_completed_at, last_counts, pending }`. Only one run happens at a
  time: while one is in flight, the button, the idle loop and the nightly run join it, and `started` is
  `false`. The events `memory.consolidating` and `memory.consolidated` mark the start and end.
- `GET /memory/status` returns the same status without starting anything.

## Events (`GET /events/stream?after=<id>`, SSE)

A client re-fetches what an event touches:

| Event | Re-fetch |
|---|---|
| `message.created`, `receipt.undone`, `desk.working`, `desk.idle`, `question.*`, `card.state` with `topic_id` | `GET /topics/:id` when that topic is open; the sidebar |
| `send.filed`, `send.handled`, `capture.failed` (`ref_id` = send id) | `GET /sends/:id` when that screen is open |
| `topic.created`, `topic.updated` | the sidebar |
| anything else | the open secondary view, debounced |
