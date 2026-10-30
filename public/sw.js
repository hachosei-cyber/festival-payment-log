// 画面ファイルを端末に保存し、電波がなくてもアプリを開けるようにする
const CACHE = "register-v05";
const SHELL = ["./", "index.html", "style.css", "app.js", "firebase-config.js", "manifest.json", "icon.png", "apple-touch-icon.png", "favicon.png", "logo.png"];
const SDK = ["firebase-app.js", "firebase-auth.js", "firebase-firestore.js"]
  .map((f) => "https://www.gstatic.com/firebasejs/11.0.2/" + f);

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll([...SHELL, ...SDK])).then(() => self.skipWaiting()));
});
self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});
self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET") return;
  if (url.origin === "https://www.gstatic.com") {
    // SDK はバージョン固定なのでキャッシュ優先
    e.respondWith(caches.match(e.request).then((r) => r || fetch(e.request).then((res) => {
      if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(e.request, copy)); }
      return res;
    })));
    return;
  }
  if (url.origin !== self.location.origin) return;
  // 自分のファイルはネット優先(修正をすぐ反映)。3秒で返らなければ保存分を使う
  const net = fetch(e.request, { cache: "no-cache" }).then((res) => {
    if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(e.request, copy)); }
    return res;
  });
  const timeout = new Promise((resolve) => setTimeout(resolve, 3000))
    .then(() => caches.match(e.request, { ignoreSearch: true }));
  e.respondWith(Promise.race([net.catch(() => null), timeout])
    .then((r) => r || caches.match(e.request, { ignoreSearch: true }))
    .then((r) => r || net));
});
