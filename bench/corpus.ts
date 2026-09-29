// The offline web for the benchmark: a fixed set of pages (bench/corpus/*.md), so runs are reproducible (§14.3).

import { FetchedPage, SearchHit, WebBackend } from "../src/tools/web.ts";

interface Page {
  url: string;
  title: string;
  text: string;
  keywords: string; // stands in for a real engine's synonym/language matching; not shown to the model
}
let corpus: Page[] | null = null;
function loadCorpus(): Page[] {
  const dir = new URL("./corpus/", import.meta.url).pathname;
  if (corpus) return corpus;
  corpus = [];
  for (const e of Deno.readDirSync(dir)) {
    if (!e.name.endsWith(".md")) continue;
    const raw = Deno.readTextFileSync(dir + e.name);
    const m = raw.match(/^url:\s*(.+)\ntitle:\s*(.+)\n(?:keywords:\s*(.+)\n)?\n([\s\S]*)$/);
    if (m) corpus.push({ url: m[1].trim(), title: m[2].trim(), keywords: (m[3] ?? "").trim(), text: m[4].trim() });
  }
  return corpus;
}

const words = (s: string) => s.toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g, "").match(/[\p{L}\p{N}]+/gu) ?? [];

function search(query: string): SearchHit[] {
  const q = [...new Set(words(query).filter((w) => w.length > 2))];
  const scored = loadCorpus().map((p) => {
    const tw = new Set([...words(p.title), ...words(p.keywords)]);
    const bw = words(p.text);
    const bset = new Set(bw);
    let s = 0;
    for (const w of q) s += (tw.has(w) ? 3 : 0) + (bset.has(w) ? 1 : 0);
    return { p, s };
  }).filter((x) => x.s >= Math.max(2, q.length * 0.5)).sort((a, b) => b.s - a.s).slice(0, 5);
  return scored.map(({ p }) => ({ title: p.title, url: p.url, snippet: snippet(p.text, q) }));
}

function snippet(text: string, q: string[]): string {
  const sentences = text.replace(/\n+/g, " ").split(/(?<=[.!?])\s+/);
  let best = sentences[0] ?? "", bs = -1;
  for (const s of sentences.slice(0, 12)) { // snippets come from the top of the page, like real engines
    const sw = new Set(words(s));
    const sc = q.filter((w) => sw.has(w)).length;
    if (sc > bs) (bs = sc), (best = s);
  }
  return best.slice(0, 200);
}

function fetch(url: string): FetchedPage | null {
  const norm = (u: string) => u.replace(/^https?:\/\/(www\.)?/, "").replace(/\/$/, "");
  const p = loadCorpus().find((p) => norm(p.url) === norm(url));
  return p ? { title: p.title, text: p.text } : null;
}

export const corpusBackend: WebBackend = { search, fetch };
