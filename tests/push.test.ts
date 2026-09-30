// Web Push sender (src/push.ts): encryption a push client can decrypt, VAPID a push service accepts,
// and delivery of push-level events to a local endpoint.

import { assert, assertEquals, assertRejects } from "jsr:@std/assert@1";
import { DB, db, setDefaultDb } from "../src/db.ts";
import { emit } from "../src/events.ts";
import { addSubscription, b64url, deliverAll, encrypt, installPush, listSubscriptions, unb64url, vapidAuth, vapidKeys } from "../src/push.ts";

const enc = new TextEncoder();
setDefaultDb(new DB(":memory:"));

async function hkdf(salt: Uint8Array<ArrayBuffer>, ikm: Uint8Array<ArrayBuffer>, info: Uint8Array<ArrayBuffer>, bytes: number) {
  const k = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info }, k, bytes * 8));
}

/** A push client: its keys, as a browser or the UnifiedPush connector would make them. */
async function client() {
  const pair = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]) as CryptoKeyPair;
  const pub = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
  const auth = crypto.getRandomValues(new Uint8Array(16));
  return { pair, pub, auth, keys: { p256dh: b64url(pub), auth: b64url(auth) } };
}

/** The receiving side of RFC 8291 / RFC 8188, written from the RFC, independent of the sender. */
async function decrypt(body: Uint8Array, c: Awaited<ReturnType<typeof client>>) {
  const salt = body.slice(0, 16);
  const rs = new DataView(body.buffer, body.byteOffset + 16, 4).getUint32(0);
  const idlen = body[20];
  const asPub = body.slice(21, 21 + idlen);
  const ct = body.slice(21 + idlen);
  assertEquals(rs, 4096);
  assertEquals(idlen, 65);
  const as = await crypto.subtle.importKey("raw", asPub, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const ecdh = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: as }, c.pair.privateKey, 256));
  const info = new Uint8Array([...enc.encode("WebPush: info\0"), ...c.pub, ...asPub]);
  const ikm = await hkdf(c.auth, ecdh, info, 32);
  const cek = await hkdf(salt, ikm, enc.encode("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdf(salt, ikm, enc.encode("Content-Encoding: nonce\0"), 12);
  const key = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["decrypt"]);
  const plain = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: nonce }, key, ct));
  assertEquals(plain[plain.length - 1], 2, "last-record delimiter");
  return new TextDecoder().decode(plain.slice(0, -1));
}

Deno.test("encrypt: a push client decrypts the payload", async () => {
  const c = await client();
  const body = await encrypt(enc.encode("hello ✓"), c.keys.p256dh, c.keys.auth);
  assertEquals(await decrypt(body, c), "hello ✓");
});

Deno.test("vapid: the JWT is ES256-signed by the key clients subscribe with", async () => {
  const auth = await vapidAuth("https://push.example.org/wpush/abc?x=1");
  const m = auth.match(/^vapid t=([^.]+)\.([^.]+)\.([^,]+), k=(.+)$/)!;
  assert(m, auth);
  const { publicKey } = await vapidKeys();
  assertEquals(m[4], publicKey);
  assertEquals(unb64url(publicKey).length, 65);
  const claims = JSON.parse(new TextDecoder().decode(unb64url(m[2])));
  assertEquals(claims.aud, "https://push.example.org");
  assert(claims.exp > Date.now() / 1000 && claims.exp <= Date.now() / 1000 + 24 * 3600);
  assert(/^(mailto|https):/.test(claims.sub));
  const key = await crypto.subtle.importKey("raw", unb64url(publicKey), { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
  assert(await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, key, unb64url(m[3]), enc.encode(`${m[1]}.${m[2]}`)));
  // the key pair is made once and kept
  assertEquals((await vapidKeys()).publicKey, publicKey);
});

Deno.test("subscriptions: validated, one row per endpoint", async () => {
  const c = await client();
  const offCurve = new Uint8Array(65);
  offCurve[0] = 4;
  await assertRejects(() => addSubscription({ endpoint: "ftp://x", keys: c.keys }));
  await assertRejects(() => addSubscription({ endpoint: "https://x/1", keys: { p256dh: c.keys.p256dh, auth: "AAAA" } }));
  await assertRejects(() => addSubscription({ endpoint: "https://x/1", keys: { p256dh: "AAAA", auth: c.keys.auth } }));
  await assertRejects(() => addSubscription({ endpoint: "https://x/1", keys: { p256dh: b64url(offCurve), auth: c.keys.auth } }));
  const a = await addSubscription({ endpoint: "https://x/1", keys: c.keys, client_id: "web" });
  const b = await addSubscription({ endpoint: "https://x/1", keys: c.keys, client_id: "android" });
  assertEquals(a.id, b.id);
  assertEquals(listSubscriptions().filter((s) => s.endpoint === "https://x/1").map((s) => s.client_id), ["android"]);
  db().run(`DELETE FROM push_subscriptions`);
});

Deno.test("delivery: push-level events reach the endpoint; gone subscriptions are removed", async () => {
  const c = await client();
  const got: { headers: Headers; body: Uint8Array }[] = [];
  let status = 201;
  const server = Deno.serve({ hostname: "127.0.0.1", port: 0, onListen: () => {} }, async (req) => {
    got.push({ headers: req.headers, body: new Uint8Array(await req.arrayBuffer()) });
    return new Response(null, { status });
  });
  const endpoint = `http://127.0.0.1:${server.addr.port}/up/abc`;
  try {
    await addSubscription({ endpoint, keys: c.keys, client_id: "android" });
    installPush();
    db().run(`INSERT INTO topics (id, slug, title) VALUES ('top_1', 'garden', 'Garden')`);

    emit("question.created", { topic_id: "top_1", ref_id: "qst_1", payload: { id: "qst_1", text: "Which kit?" }, kind: "question" });
    emit("card.state", { topic_id: "top_1", ref_id: "crd_1", payload: {} }); // silent: not pushed
    for (let i = 0; i < 50 && got.length < 1; i++) await new Promise((r) => setTimeout(r, 20));
    assertEquals(got.length, 1);
    const h = got[0].headers;
    assertEquals(h.get("content-encoding"), "aes128gcm");
    assertEquals(h.get("urgency"), "high");
    assert(Number(h.get("ttl")) > 0);
    assert(h.get("authorization")!.startsWith("vapid t="));
    const m = JSON.parse(await decrypt(got[0].body, c));
    assertEquals([m.type, m.kind, m.title, m.body, m.topic_id, m.ref_id], ["question.created", "question", "Garden", "Which kit?", "top_1", "qst_1"]);
    assertEquals(listSubscriptions()[0].failures, 0);

    status = 500;
    await deliverAll({ body: "x" });
    assertEquals(listSubscriptions()[0].failures, 1);

    status = 410;
    const [r] = await deliverAll({ body: "x" });
    assert(r.removed);
    assertEquals(listSubscriptions().length, 0);
  } finally {
    await server.shutdown();
  }
});
