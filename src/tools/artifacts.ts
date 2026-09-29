// Artifacts (DESIGN §8). Stored in the database for the prototype; long tool results are paged.

import { db, nowIso, Row } from "../db.ts";
import { newId } from "../ids.ts";
import { config } from "../config.ts";
import { emit } from "../events.ts";
import { contentBlock } from "./web.ts";

export function saveArtifact(a: { card_id: string | null; name: string; content: string; origin: string; summary?: string; mime?: string }): Row {
  const row = {
    id: newId("art"),
    card_id: a.card_id,
    name: a.name,
    content: a.content,
    bytes: new TextEncoder().encode(a.content).length,
    mime: a.mime ?? "text/plain",
    summary: a.summary ?? "",
    origin: a.origin,
    created_at: nowIso(),
  };
  db().insert("artifacts", row);
  emit("artifact.created", { ref_id: row.id, payload: { id: row.id, name: row.name, card_id: a.card_id, bytes: row.bytes } });
  return row;
}

export function getArtifact(id: string): Row | undefined {
  return db().get(`SELECT * FROM artifacts WHERE id=?`, id);
}

/** Position header comes FIRST so truncation can never remove it (§11). The text itself is data (§12). */
export function page(art: Row, from: number, source: string): string {
  const w = config.tool_result_window;
  const text = art.content as string;
  const a = Math.max(0, Math.min(from, text.length));
  const b = Math.min(text.length, a + w);
  const more = b < text.length ? ` Continue with read_artifact("${art.id}", ${b}) if you need more.` : " This is the end.";
  const footer = b < text.length ? `\n[The text continues. Read the rest with read_artifact("${art.id}", ${b}).]` : "";
  const attrs: Record<string, string> = art.origin === "tool_result" ? { url: source } : { file: source };
  return `[characters ${a}–${b} of ${text.length} from ${source}.${more}]\n${contentBlock(attrs, text.slice(a, b))}${footer}`;
}

export const wordCount = (s: string) => (s.match(/\S+/g) ?? []).length;
