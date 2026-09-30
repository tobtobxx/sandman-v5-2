// Service worker of the client UI: shows Web Push notifications (src/push.ts) when no Sandman tab
// has focus, and opens the topic when one is tapped.

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));

self.addEventListener("push", (e) => {
  let m = {};
  try { m = e.data?.json() ?? {}; } catch { m = { body: e.data?.text() }; }
  e.waitUntil((async () => {
    // A focused tab already shows it (and browsers don't ask for a notification then)
    const wins = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    if (m.type !== "push.test" && wins.some((w) => w.focused)) return;
    await self.registration.showNotification(m.title ?? "Sandman", {
      body: m.body ?? "", tag: `sandman-${m.id ?? Date.now()}`, data: { topic_id: m.topic_id ?? null },
    });
  })());
});

self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  const hash = e.notification.data?.topic_id ? `#topic/${e.notification.data.topic_id}` : "#home";
  e.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    const w = wins[0];
    if (w) {
      await w.focus();
      return w.navigate(new URL(hash, self.registration.scope).href);
    }
    return self.clients.openWindow(hash);
  })());
});
