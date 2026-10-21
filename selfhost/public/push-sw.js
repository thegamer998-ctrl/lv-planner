// Express Tech Design Center — phone / computer notifications (web push). Registered with scope /push/ so it never
// takes over the pages; it only shows notifications and opens the right page when one is tapped.
self.addEventListener("install", function(){ self.skipWaiting(); });
self.addEventListener("activate", function(e){ e.waitUntil(self.clients.claim()); });
self.addEventListener("push", function(e){
  var d = {}; try { d = e.data ? e.data.json() : {}; } catch(x){ d = { title:"Express Tech", body:e.data ? e.data.text() : "" }; }
  e.waitUntil(self.registration.showNotification(d.title || "Express Tech", { body:d.body || "", tag:d.tag || undefined, renotify:!!d.tag,
    data:{ url:d.url || "/" }, icon:"/app/icon-192.png", badge:"/app/icon-192.png" }));
});
self.addEventListener("notificationclick", function(e){
  e.notification.close();
  var url = new URL((e.notification.data && e.notification.data.url) || "/", self.location.origin).href;
  e.waitUntil(self.clients.matchAll({ type:"window", includeUncontrolled:true }).then(function(list){
    for (var i = 0; i < list.length; i++) if (list[i].url === url && "focus" in list[i]) return list[i].focus();
    return self.clients.openWindow(url);
  }));
});
