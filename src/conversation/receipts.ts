// Receipts and undo (DESIGN §6.7). A receipt is the harness's record of an action taken for the owner.

import { db, j, nowIso, Row } from "../db.ts";
import { newId } from "../ids.ts";
import { emit } from "../events.ts";
import { postMessage } from "./messages.ts";
import { addComment, cancelCard, createCard, getCard } from "../work/board.ts";
import { reopenQuestion } from "./questions.ts";

export function addReceipt(r: { desk_turn_id?: string; topic_id: string; capture_item_id?: string | null; kind: string; ref_id: string; text: string; undo?: Row }): Row {
  const id = newId("rcp");
  const msg = postMessage({ topic_id: r.topic_id, role: "sandman", kind: "receipt", body: r.text, payload: { receipt_id: id, kind: r.kind, ref_id: r.ref_id, undoable: true }, desk_turn_id: r.desk_turn_id });
  const row = { id, ...r, message_id: msg.id, undo: r.undo ?? {}, created_at: nowIso() };
  db().insert("receipts", row);
  return row;
}

export function undoReceipt(id: string): { ok: boolean; note: string } {
  const r = db().get(`SELECT * FROM receipts WHERE id=?`, id);
  if (!r) return { ok: false, note: "no such receipt" };
  if (r.undone_at) return { ok: false, note: "already undone" };
  const undo = j<Row>(r.undo, {});
  let note = "";
  switch (r.kind) {
    case "card_created":
    case "reminder_set": {
      const c = getCard(r.ref_id);
      const ran = db().get(`SELECT count(*) n FROM sessions WHERE card_id IN (SELECT id FROM cards WHERE root_id=?) AND type IN ('worker','synthesis')`, c.id)!.n;
      cancelCard(c.id);
      note = ran ? "Cancelled the card." : "Cancelled the card before any work started.";
      break;
    }
    case "added_to_card": {
      const c = getCard(r.ref_id);
      const seen = db().get(`SELECT count(*) n FROM sessions WHERE card_id=? AND started_at > ?`, c.id, r.created_at)!.n;
      if (!seen && undo.comment_id) {
        db().run(`DELETE FROM comments WHERE id=?`, undo.comment_id);
        note = "Removed the addition.";
      } else {
        addComment(c.id, "owner", `Owner withdrew: ${undo.note ?? ""}`);
        note = "Work had already seen it; added a withdrawal note.";
      }
      break;
    }
    case "card_cancelled": {
      // cancelled is terminal: undo re-creates the card from its contract
      const c = getCard(r.ref_id);
      const nc = createCard({ title: c.title, goal: c.original_goal ?? c.goal, done_when: c.done_when, role: c.role === "synthesize" ? "research" : c.role, constraints: c.constraints, inputs: c.inputs, origin_topic_id: c.origin_topic_id, created_by: "owner" });
      note = `Restarted the card as ${nc.id}.`;
      break;
    }
    case "answered": {
      if (!reopenQuestion(r.ref_id)) {
        return { ok: false, note: "The card already resumed; add a correction instead." };
      }
      note = "Reopened the question.";
      break;
    }
    default:
      return { ok: false, note: `can't undo ${r.kind}` };
  }
  db().update("receipts", id, { undone_at: nowIso() });
  emit("receipt.undone", { topic_id: r.topic_id, ref_id: id, payload: { id, note } });
  return { ok: true, note };
}

export function receiptsFor(where: { desk_turn_id?: string; capture_item_id?: string }): Row[] {
  if (where.desk_turn_id) return db().all(`SELECT * FROM receipts WHERE desk_turn_id=? ORDER BY created_at, rowid`, where.desk_turn_id);
  return db().all(`SELECT * FROM receipts WHERE capture_item_id=? ORDER BY created_at, rowid`, where.capture_item_id);
}
