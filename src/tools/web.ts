// web_search / web_fetch: SearXNG (web.searxng in config.jsonc) if set, else DuckDuckGo's HTML endpoint
// (best effort). The benchmark swaps in its offline corpus with setWebBackend (bench/corpus.ts).

import { config } from "../config.ts";

export interface SearchHit {
  title: string;
  url: string;
  snippet: string;
}
export interface FetchedPage {
  title: string;
  text: string;
}
export interface WebBackend {
  search(query: string): SearchHit[] | Promise<SearchHit[]>;
  fetch(url: string): FetchedPage | null | Promise<FetchedPage | null>;
}

// DDG challenges bursts (about the third request within a few seconds); one request per 6 s passes.
const DDG_GAP_MS = 6000;
let ddgNext = 0;
async function ddgSlot() {
  const at = Math.max(Date.now(), ddgNext);
  ddgNext = at + DDG_GAP_MS; // reserved synchronously, so concurrent callers queue up
  if (at > Date.now()) await new Promise((r) => setTimeout(r, at - Date.now()));
}

async function liveSearch(query: string): Promise<SearchHit[]> {
  const searx = config.web.searxng;
  if (searx) {
    const r = await fetch(`${searx}/search?format=json&q=${encodeURIComponent(query)}`);
    const d = await r.json();
    return (d.results ?? []).slice(0, 6).map((x: any) => ({ title: x.title, url: x.url, snippet: (x.content ?? "").slice(0, 200) }));
  }
  await ddgSlot();
  // DDG answers with a 202 bot-challenge page ("anomaly") to GETs, and to POSTs carrying Deno's default
  // `Accept-Encoding: gzip, br`. A form POST with plain gzip and a Referer gets real results.
  const r = await fetch("https://html.duckduckgo.com/html/", {
    method: "POST",
    headers: {
      "User-Agent": "Mozilla/5.0",
      "Content-Type": "application/x-www-form-urlencoded",
      "Accept-Encoding": "gzip",
      "Referer": "https://html.duckduckgo.com/",
    },
    body: new URLSearchParams({ q: query }),
    signal: AbortSignal.timeout(20000),
  });
  const html = await r.text();
  if (r.status === 202 || /anomaly-modal|challenge-form/.test(html)) {
    throw new Error("DuckDuckGo served a bot challenge (rate limited). Try again later, or set web.searxng in config.jsonc.");
  }
  if (!r.ok) throw new Error(`DuckDuckGo returned HTTP ${r.status}.`);
  const hits: SearchHit[] = [];
  const re = /<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;
  let m;
  while ((m = re.exec(html)) && hits.length < 6) {
    let url = m[1];
    const u = url.match(/uddg=([^&]+)/);
    if (u) url = decodeURIComponent(u[1]);
    else if (url.startsWith("//")) url = "https:" + url;
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

/** Fetched text is data (§12): it goes in a <content> block, and the tag can't be closed or opened from inside. */
export function contentBlock(attrs: Record<string, string>, text: string): string {
  const esc = (v: string) => v.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const a = Object.entries(attrs).map(([k, v]) => ` ${k}="${esc(v)}"`).join("");
  return `<content${a}>\n${text.replace(/<(\/?)(content)/gi, "‹$1$2")}\n</content>`;
}

async function liveFetch(url: string): Promise<FetchedPage | null> {
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

let backend: WebBackend = { search: liveSearch, fetch: liveFetch };
export function setWebBackend(b: WebBackend) {
  backend = b;
}

export async function webSearch(query: string): Promise<SearchHit[]> {
  return await backend.search(query);
}

export async function webFetch(url: string): Promise<FetchedPage | null> {
  return await backend.fetch(url);
}
