// web_search / web_fetch backends.
// - corpus: a fixed offline set of pages (bench/corpus/*.md) so benchmark runs are reproducible (§14.3).
// - live: SearXNG (SANDMAN_SEARXNG=https://host) if set, else DuckDuckGo's HTML endpoint (best effort).

import { config } from "../config.ts";

export interface SearchHit {
  title: string;
  url: string;
  snippet: string;
}

// ---- corpus ----
interface Page {
  url: string;
  title: string;
  text: string;
  keywords: string; // stands in for a real engine's synonym/language matching; not shown to the model
}
let corpus: Page[] | null = null;
export function loadCorpus(dir = new URL("../../bench/corpus/", import.meta.url).pathname): Page[] {
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

function corpusSearch(query: string): SearchHit[] {
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

// ---- live ----
async function liveSearch(query: string): Promise<SearchHit[]> {
  const searx = Deno.env.get("SANDMAN_SEARXNG");
  if (searx) {
    const r = await fetch(`${searx}/search?format=json&q=${encodeURIComponent(query)}`);
    const d = await r.json();
    return (d.results ?? []).slice(0, 6).map((x: any) => ({ title: x.title, url: x.url, snippet: (x.content ?? "").slice(0, 200) }));
  }
  const r = await fetch(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`, { headers: { "User-Agent": "Mozilla/5.0 sandman" } });
  const html = await r.text();
  const hits: SearchHit[] = [];
  const re = /<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;
  let m;
  while ((m = re.exec(html)) && hits.length < 6) {
    let url = m[1];
    const u = url.match(/uddg=([^&]+)/);
    if (u) url = decodeURIComponent(u[1]);
    hits.push({ title: htmlToText(m[2]), url, snippet: htmlToText(m[3]).slice(0, 200) });
  }
  return hits;
}

export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style|noscript|svg|nav|footer|header)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<br\s*\/?>|<\/(p|div|li|h\d|tr)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n+/g, "\n\n")
    .trim();
}

export async function webSearch(query: string): Promise<SearchHit[]> {
  return config.web_backend === "corpus" ? corpusSearch(query) : await liveSearch(query);
}

export async function webFetch(url: string): Promise<{ title: string; text: string } | null> {
  if (config.web_backend === "corpus") {
    const norm = (u: string) => u.replace(/^https?:\/\/(www\.)?/, "").replace(/\/$/, "");
    const p = loadCorpus().find((p) => norm(p.url) === norm(url));
    return p ? { title: p.title, text: p.text } : null;
  }
  try {
    const r = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0 sandman" }, signal: AbortSignal.timeout(20000) });
    if (!r.ok) return null;
    const html = await r.text();
    const title = htmlToText(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? url);
    return { title, text: htmlToText(html) };
  } catch {
    return null;
  }
}
