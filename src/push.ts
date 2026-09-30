// Web Push (DESIGN §6.12 "Delivery when no client is open", #43). One sender serves browsers
// (PushSubscription from a service worker) and the Android app (UnifiedPush, docs/ANDROID.md):
// both hand over an endpoint URL, a P-256 public key and an auth secret.
//   RFC 8030  the push request: POST to the endpoint, TTL and Urgency headers
//   RFC 8291  payload encryption (ECDH + HKDF + AES-128-GCM, content coding aes128gcm, RFC 8188)
//   RFC 8292  VAPID: the server signs a JWT per push service; clients subscribe with its public key
// WebCrypto only, no dependencies. The VAPID key pair is made on first use and kept in the database.

import { db, nowIso, Row } from "./db.ts";
import { config } from "./config.ts";
import { newId } from "./ids.ts";
import { subscribe } from "./events.ts";

const enc = new TextEncoder();
type Bytes = Uint8Array<ArrayBuffer>;

export const b64url = (b: Uint8Array) => btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
export function unb64url(s: string): Bytes {
  const t = s.replace(/-/g, "+").replace(/_/g, "/").replace(/=+$/, "");
  return Uint8Array.from(atob(t + "=".repeat((4 - (t.length % 4)) % 4)), (c) => c.charCodeAt(0));
}
const concat = (...parts: Uint8Array[]): Bytes => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let i = 0;
  for (const p of parts) (out.set(p, i), i += p.length);
  return out;
};

// ---------------------------------------------------------------- VAPID key pair

let vapid: { publicKey: string; key: CryptoKey } | null = null;
let vapidDb: unknown = null;

/** The server's VAPID key pair: the public key (base64url, uncompressed P-256) and the signing key. */
export async function vapidKeys() {
  if (vapid && vapidDb === db()) return vapid;
  let row = db().get(`SELECT * FROM vapid_keys WHERE id=1`);
  if (!row) {
    const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]) as CryptoKeyPair;
    const pub = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
    row = { id: 1, public_key: b64url(pub), private_jwk: JSON.stringify(await crypto.subtle.exportKey("jwk", pair.privateKey)), created_at: nowIso() };
    db().run(`INSERT OR IGNORE INTO vapid_keys (id, public_key, private_jwk, created_at) VALUES (1,?,?,?)`, row.public_key, row.private_jwk, row.created_at);
    row = db().get(`SELECT * FROM vapid_keys WHERE id=1`);
  }
  const key = await crypto.subtle.importKey("jwk", JSON.parse(row.private_jwk), { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  vapid = { publicKey: row.public_key, key };
  vapidDb = db();
  return vapid;
}

/** `Authorization` header for one push service (RFC 8292 §2–3). Valid for 12 hours. */
export async function vapidAuth(endpoint: string): Promise<string> {
  const { publicKey, key } = await vapidKeys();
  const header = b64url(enc.encode(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const claims = b64url(enc.encode(JSON.stringify({
    aud: new URL(endpoint).origin, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: config.push.subject,
  })));
  // WebCrypto signs ECDSA as r‖s, which is what JWS ES256 wants
  const sig = new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, enc.encode(`${header}.${claims}`)));
  return `vapid t=${header}.${claims}.${b64url(sig)}, k=${publicKey}`;
}

// ---------------------------------------------------------------- encryption (RFC 8291)

async function hkdf(salt: Bytes, ikm: Bytes, info: Bytes, bytes: number) {
  const k = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info }, k, bytes * 8));
}

/** Encrypt `payload` for a subscription: the aes128gcm body with one record (RFC 8291 §3.4, RFC 8188 §2). */
export async function encrypt(payload: Uint8Array, p256dh: string, auth: string): Promise<Bytes> {
  const uaPublic = unb64url(p256dh);
  const authSecret = unb64url(auth);
  const ua = await crypto.subtle.importKey("raw", uaPublic, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const as = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]) as CryptoKeyPair;
  const asPublic = new Uint8Array(await crypto.subtle.exportKey("raw", as.publicKey));
  const ecdh = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: ua }, as.privateKey, 256));
  const ikm = await hkdf(authSecret, ecdh, concat(enc.encode("WebPush: info\0"), uaPublic, asPublic), 32);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(salt, ikm, enc.encode("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdf(salt, ikm, enc.encode("Content-Encoding: nonce\0"), 12);
  const key = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["encrypt"]);
  // 0x02: the delimiter of the last (only) record, no padding
  const sealed = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, key, concat(payload, new Uint8Array([2]))));
  const rs = new Uint8Array(4);
  new DataView(rs.buffer).setUint32(0, 4096);
  return concat(salt, rs, new Uint8Array([asPublic.length]), asPublic, sealed);
}

// ---------------------------------------------------------------- subscriptions

export interface SubscriptionInput {
  endpoint?: string;
  keys?: { p256dh?: string; auth?: string };
  client_id?: string;
}

/** Register or refresh a subscription (the shape of a browser's `PushSubscription.toJSON()`). One row per endpoint. */
export async function addSubscription(b: SubscriptionInput) {
  const endpoint = String(b.endpoint ?? "");
  const p256dh = b.keys?.p256dh ?? "", auth = b.keys?.auth ?? "";
  if (!/^https?:\/\//.test(endpoint)) throw new Error("endpoint must be an http(s) URL");
  let pub: Bytes, secret: Bytes;
  try {
    pub = unb64url(p256dh);
    secret = unb64url(auth);
  } catch {
    throw new Error("keys.p256dh and keys.auth must be base64url");
  }
  if (pub.length !== 65 || pub[0] !== 4) throw new Error("keys.p256dh must be an uncompressed P-256 public key");
  if (secret.length !== 16) throw new Error("keys.auth must be 16 bytes");
  // a trial encryption: the key agreement fails for a point that isn't on the curve
  await encrypt(new Uint8Array(0), p256dh, auth).catch(() => Promise.reject(new Error("keys.p256dh is not a P-256 public key")));
  const old = db().get(`SELECT id FROM push_subscriptions WHERE endpoint=?`, endpoint);
  const id = old?.id ?? newId("psb");
  const row = { client_id: b.client_id ?? null, p256dh, auth, active: 1, failures: 0, last_error: null };
  if (old) db().update("push_subscriptions", id, row);
  else db().insert("push_subscriptions", { id, endpoint, ...row, created_at: nowIso() });
  return { id };
}

export function removeSubscription(endpoint: string) {
  const r = db().run(`DELETE FROM push_subscriptions WHERE endpoint=?`, endpoint);
  return { removed: Number(r.changes) };
}

export function listSubscriptions() {
  return db().all(`SELECT id, client_id, endpoint, active, failures, last_error, last_ok_at, created_at FROM push_subscriptions ORDER BY created_at`);
}

// ---------------------------------------------------------------- delivery

/** What a notification shows. Kept small: push services cap payloads at about 4 KB. */
export function pushMessage(ev: Row) {
  const p = ev.payload ?? {};
  const topic = ev.topic_id ? db().get(`SELECT title FROM topics WHERE id=?`, ev.topic_id)?.title : null;
  const kind = ev.type === "question.created" ? "question" : p.kind ?? ev.type;
  const body = String(p.text ?? p.body ?? p.title ?? ev.type);
  return {
    id: ev.id, type: ev.type, kind, topic_id: ev.topic_id ?? null, ref_id: ev.ref_id ?? null,
    title: topic ?? "Sandman", body: body.length > 600 ? body.slice(0, 599) + "…" : body, at: ev.at,
  };
}

/** Send one message to one subscription. 404/410 means the subscription is gone and it is deleted. */
export async function deliver(sub: Row, message: unknown, opts: { urgency?: string; ttl?: number } = {}) {
  let status = 0, error: string | null = null;
  try {
    const body = await encrypt(enc.encode(JSON.stringify(message)), sub.p256dh, sub.auth);
    const res = await fetch(sub.endpoint, {
      method: "POST",
      headers: {
        "content-encoding": "aes128gcm",
        "content-type": "application/octet-stream",
        ttl: String(opts.ttl ?? config.push.ttl_s),
        urgency: opts.urgency ?? "high",
        authorization: await vapidAuth(sub.endpoint),
      },
      body,
    });
    status = res.status;
    if (!res.ok) error = `HTTP ${res.status}: ${(await res.text().catch(() => "")).slice(0, 200)}`;
    else await res.body?.cancel();
  } catch (e) {
    error = (e as Error).message;
  }
  if (status === 404 || status === 410) {
    db().run(`DELETE FROM push_subscriptions WHERE id=?`, sub.id);
  } else if (error) {
    db().run(`UPDATE push_subscriptions SET failures=failures+1, last_error=? WHERE id=?`, error, sub.id);
  } else {
    db().run(`UPDATE push_subscriptions SET failures=0, last_error=NULL, last_ok_at=? WHERE id=?`, nowIso(), sub.id);
  }
  return { id: sub.id, ok: !error, status, error, removed: status === 404 || status === 410 };
}

/** Send to every active subscription. */
export function deliverAll(message: unknown, opts: { urgency?: string; ttl?: number } = {}) {
  const subs = db().all(`SELECT * FROM push_subscriptions WHERE active=1`);
  return Promise.all(subs.map((s) => deliver(s, message, opts)));
}

/** Deliver every `push`-level event (§6.12). Clients drop what they already show on screen. */
export function installPush() {
  subscribe((ev) => {
    if (ev.notify !== "push") return;
    deliverAll(pushMessage(ev)).catch((e) => console.error("push:", e));
  });
}

/** A test notification, for the settings screens. */
export function sendTest() {
  return deliverAll({ id: 0, type: "push.test", kind: "test", topic_id: null, ref_id: null, title: "Sandman", body: "Notifications work.", at: nowIso() }, { ttl: 60 });
}
