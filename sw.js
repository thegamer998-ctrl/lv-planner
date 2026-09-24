// Offline cache for the LV Planner home-screen app.
// Serves cached files instantly and refreshes them in the background,
// so an update you upload shows up on the second launch.
var CACHE = "lvplanner-v1";
var SHELL = [
  "./", "./index.html", "./manifest.webmanifest",
  "./apple-touch-icon.png", "./icon-192.png", "./icon-512.png",
  "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js",
  "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js",
  "https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js"
];
self.addEventListener("install", function(e){
  e.waitUntil(caches.open(CACHE).then(function(c){
    return Promise.all(SHELL.map(function(u){ return c.add(u).catch(function(){}); }));
  }).then(function(){ return self.skipWaiting(); }));
});
self.addEventListener("activate", function(e){
  e.waitUntil(caches.keys().then(function(keys){
    return Promise.all(keys.filter(function(k){ return k !== CACHE; }).map(function(k){ return caches.delete(k); }));
  }).then(function(){ return self.clients.claim(); }));
});
self.addEventListener("fetch", function(e){
  var req = e.request;
  if (req.method !== "GET") return;                                  // never touch AI scan requests
  if (new URL(req.url).hostname === "api.anthropic.com") return;
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
