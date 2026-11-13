// オフラインでも開けるように、アプリの部品をスマホに置いておく。
// アプリを直したら VERSION を変える（変えると、次に開いたときに新しい部品に入れ替わる）。
const VERSION = "v1.8.0";
const CACHE = `helper-app-${VERSION}`;
const FILES = [
  "./", "./index.html", "./manifest.webmanifest", "./css/style.css",
  "./js/app.js", "./js/util.js", "./js/schedule.js", "./js/core.js", "./js/pdf.js", "./js/setup.js", "./js/tour.js", "./js/gcal.js",
  "./img/form-blank.png", "./img/icon-192.png", "./img/icon-512.png", "./img/apple-touch-icon.png",
];

self.addEventListener("install", (e) => {
  // ブラウザが一時的に覚えている古い部品ではなく、必ず公開場所から取り直す
  e.waitUntil(caches.open(CACHE)
    .then((c) => c.addAll(FILES.map((f) => new Request(f, { cache: "reload" }))))
    .then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k.startsWith("helper-app-") && k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== location.origin) return;   // 稼働表（Google）はそのまま
  if (url.pathname.endsWith("/sheets.json")) return;                          // 稼働表の場所は毎回新しく
  // まずネットから（新しい版があればそれを使う）。電波が弱くて3秒で返らなければ、スマホに置いた部品を使う。
  e.respondWith((async () => {
    const cache = await caches.open(CACHE);
    // 公開場所に「変わったか」を必ず聞く（ブラウザが10分ほど古い部品を使い回すのを防ぐ）
    // （ページを開くときの要求には条件を足せないので、アドレスから取り直す）
    const net = fetch(e.request.url, { cache: "no-cache" }).then((res) => {
      if (res.ok) cache.put(e.request, res.clone());
      return res;
    });
    net.catch(() => {});      // 先にスマホの部品を返したときの、ネットの失敗は気にしない
    const cached = await cache.match(e.request, { ignoreSearch: true });
    const timeout = new Promise((resolve) => setTimeout(() => resolve(null), cached ? 3000 : 15000));
    try {
      const res = await Promise.race([net, timeout]);
      if (res) return res;
    } catch { /* つながらない */ }
    if (cached) return cached;
    if (e.request.mode === "navigate") {
      const index = await cache.match("./index.html");
      if (index) return index;
    }
    return net;     // 最後はネットの結果を待つ（失敗ならそのままエラー）
  })());
});
