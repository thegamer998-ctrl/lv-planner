// LV Planner offline cache - v2
// The app page itself: always fetched fresh when online (you get updates immediately);
// the saved copy is only used when there's no internet.
// Libraries and icons: served from the saved copy, refreshed in the background.
var CACHE = "lvplanner-v2";
var SHELL = [
  "./", "./index.html", "./manifest.webmanifest",
  "./apple-touch-icon.png", "./icon-192.png", "./icon-512.png",
  "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js",
  "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js",
  "https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js"
];
self.addEventListener("install", function(e){
  e.waitUntil(caches.open(CACHE).then(function(c){
    return Promise.all(SHELL.map(function(u){
      return c.add(new Request(u, { cache:"reload" })).catch(function(){});
    }));
  }).then(function(){ return self.skipWaiting(); }));
});
self.addEventListener("activate", function(e){
  e.waitUntil(caches.keys().then(function(keys){
    return Promise.all(keys.filter(function(k){ return k !== CACHE; }).map(function(k){ return caches.delete(k); }));
  }).then(function(){ return self.clients.claim(); }));
});
function isAppPage(req, url){
  if (req.mode === "navigate") return true;
  return url.origin === self.location.origin && (/\/$/.test(url.pathname) || /index\.html$/.test(url.pathname));
}
self.addEventListener("fetch", function(e){
  var req = e.request;
  if (req.method !== "GET") return;
  var url = new URL(req.url);
  if (url.hostname === "api.anthropic.com") return;

  if (isAppPage(req, url)){
    e.respondWith(
      fetch(new Request(url.href, { cache:"no-store", credentials:"same-origin" })).then(function(res){
        if (res && res.ok){ var copy = res.clone(); caches.open(CACHE).then(function(c){ c.put("./index.html", copy); }); }
        return res;
      }).catch(function(){
        return caches.open(CACHE).then(function(c){
          return c.match(req).then(function(hit){ return hit || c.match("./index.html"); });
        });
      })
    );
    return;
  }

  e.respondWith(caches.open(CACHE).then(function(cache){
    return cache.match(req).then(function(hit){
      var net = fetch(req).then(function(res){
        if (res && (res.ok || res.type === "opaque")) cache.put(req, res.clone());
        return res;
      }).catch(function(){ return hit; });
      return hit || net;
    });
  }));
});
