// Prefixed, time-sortable IDs (DESIGN §4). Shorter than a full ULID so prompts stay cheap:
// 8 chars of millisecond time + 4 random chars, Crockford base32.

const B32 = "0123456789abcdefghjkmnpqrstvwxyz";
let lastTime = 0;
let seq = 0;

export function newId(prefix: string): string {
  let t = Date.now();
  if (t <= lastTime) t = lastTime; // monotonic within process
  seq = t === lastTime ? seq + 1 : 0;
  lastTime = t;
  let ts = "";
  let n = t;
  for (let i = 0; i < 8; i++) {
    ts = B32[n % 32] + ts;
    n = Math.floor(n / 32);
  }
  const rnd = crypto.getRandomValues(new Uint8Array(4));
  let r = B32[seq % 32];
  for (let i = 1; i < 4; i++) r += B32[rnd[i] % 32];
  return `${prefix}_${ts}${r}`;
}

export const nowIso = () => new Date().toISOString();
