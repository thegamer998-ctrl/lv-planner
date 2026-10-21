/* Express Tech Design Center — what the self-hosted server adds to the planner, the site app and the home page.
   Loaded by /app/index.html (planner) and /app/site.html (site app) through one <script> line the server adds, and by the
   Design Center home page (/). The planner and the site app work without it (GitHub Pages copy); with it:
     - sign-in instead of server addresses and office keys (the server adds the right key for each person)
     - planner projects saved under your login while you work, opened on any device, shared with others
     - the bell: notifications, live
*/
(function(){
  "use strict";
  var E = window.EXPRESS = window.EXPRESS || {};
  E.hosted = true;
  var path = location.pathname;
  var PAGE = /\/app\/site\.html$/.test(path) ? "site" : /^\/app\/(index\.html)?$/.test(path) ? "planner" : "portal";
  E.page = PAGE;

  /* ================= small helpers ================= */
  function esc(s){ return String(s == null ? "" : s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;"); }
  function ago(iso){
    if (!iso) return ""; var t = typeof iso === "number" ? iso : Date.parse(iso), s = (Date.now() - t) / 1000;
    if (s < 50) return "just now"; if (s < 3600) return Math.round(s / 60) + " min ago"; if (s < 86400) return Math.round(s / 3600) + " h ago";
    if (s < 7 * 86400) return Math.round(s / 86400) + " d ago";
    return new Date(t).toLocaleDateString(undefined, { day:"numeric", month:"short", year: new Date(t).getFullYear() === new Date().getFullYear() ? undefined : "numeric" });
  }
  function api(method, url, body, opts){
    opts = opts || {};
    var h = { "X-Express":"1" }, b = body;
    if (body !== undefined && !(body instanceof Blob) && !(body instanceof ArrayBuffer) && !(body instanceof Uint8Array)){ h["Content-Type"] = "application/json"; b = JSON.stringify(body); }
    Object.assign(h, opts.headers || {});
    return fetch(url, { method:method, headers:h, body:b, credentials:"same-origin", cache:"no-store" }).then(function(r){
      return r.json().catch(function(){ return {}; }).then(function(j){
        if (!r.ok){ var e = new Error(j.error || ("Error " + r.status)); e.status = r.status; e.data = j; throw e; }
        return j;
      });
    });
  }
  E.api = api; E.esc = esc; E.ago = ago;
  // this tab: so a save made here is not taken for someone else's (the same person on the iPad is "someone else")
  E.clientId = Math.random().toString(36).slice(2) + Date.now().toString(36);
  function initials(n){ return String(n || "?").trim().split(/\s+/).slice(0, 2).map(function(w){ return w[0]; }).join("").toUpperCase(); }
  E.initials = initials;

  /* ================= look ================= */
  var css = [
    ".etx{ --etx-panel:var(--bg-panel, var(--panel, #fff)); --etx-raised:var(--bg-panel-raised, var(--panel-2, #f6f6f6)); --etx-line:var(--hairline, var(--line, #e5e5e6));",
    "  --etx-text:var(--text-main, var(--text, #232323)); --etx-muted:var(--text-muted, var(--muted, #717171)); --etx-hover:var(--bg-hover, rgba(0,0,0,.05)); --etx-red:#D21E1C; }",
    ".etx, .etx *{ box-sizing:border-box; }",
    ".etx-bar{ display:flex; align-items:center; gap:6px; flex-shrink:0; }",
    ".etx-ib{ height:34px; min-width:34px; padding:0 9px; border-radius:9px; border:1px solid var(--etx-line); background:var(--etx-panel); color:var(--etx-text); display:inline-flex; align-items:center; justify-content:center; gap:6px; font:600 12.5px/1 inherit; cursor:pointer; position:relative; white-space:nowrap; }",
    ".etx-ib:hover{ background:var(--etx-hover); } .etx-ib svg{ width:17px; height:17px; flex-shrink:0; }",
    ".etx-badge{ position:absolute; top:-5px; right:-5px; min-width:18px; height:18px; padding:0 5px; border-radius:9px; background:var(--etx-red); color:#fff; font:700 10.5px/18px inherit; text-align:center; box-shadow:0 0 0 2px var(--etx-panel); }",
    ".etx-av{ width:30px; height:30px; border-radius:50%; background:#2b2b2b; color:#fff; display:grid; place-items:center; font:700 11.5px/1 inherit; letter-spacing:.02em; flex-shrink:0; }",
    ".etx-avbtn{ border:0; background:none; padding:0; cursor:pointer; border-radius:50%; } .etx-avbtn:focus-visible{ outline:2px solid var(--etx-red); outline-offset:2px; }",
    ".etx-chip{ font:600 11.5px/1 inherit; color:var(--etx-muted); padding:0 4px; white-space:nowrap; display:inline-flex; align-items:center; gap:5px; cursor:default; }",
    ".etx-chip i{ width:7px; height:7px; border-radius:50%; background:#12a150; display:inline-block; } .etx-chip.saving i{ background:#eab308; } .etx-chip.bad i{ background:var(--etx-red); } .etx-chip.bad{ color:var(--etx-red); cursor:pointer; }",
    ".etx-who{ display:flex; } .etx-who .etx-av{ width:26px; height:26px; font-size:10px; margin-left:-6px; box-shadow:0 0 0 2px var(--etx-panel); background:#808080; } .etx-who .etx-av:first-child{ margin-left:0; }",
    ".etx-pop{ position:fixed; z-index:100000; width:min(380px, calc(100vw - 16px)); max-height:min(72vh, 620px); display:flex; flex-direction:column; background:var(--etx-panel); color:var(--etx-text); border:1px solid var(--etx-line); border-radius:14px; box-shadow:0 18px 50px rgba(0,0,0,.22); overflow:hidden; font:14px/1.35 -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; }",
    ".etx-pop header{ display:flex; align-items:center; gap:8px; padding:12px 14px; border-bottom:1px solid var(--etx-line); } .etx-pop header b{ flex:1; font-size:14.5px; }",
    ".etx-link{ border:0; background:none; color:var(--etx-red); font:600 12.5px/1 inherit; cursor:pointer; padding:4px; }",
    ".etx-list{ overflow:auto; flex:1; } .etx-empty{ padding:28px 16px; text-align:center; color:var(--etx-muted); font-size:13px; }",
    ".etx-n{ display:flex; gap:10px; padding:11px 14px; border-bottom:1px solid var(--etx-line); cursor:pointer; text-align:left; width:100%; background:none; border-left:0; border-right:0; border-top:0; color:inherit; font:inherit; }",
    ".etx-n:hover{ background:var(--etx-hover); } .etx-n .dot{ width:8px; height:8px; border-radius:50%; margin-top:6px; flex-shrink:0; background:transparent; } .etx-n.new .dot{ background:var(--etx-red); }",
    ".etx-n b{ display:block; font-size:13.5px; font-weight:600; } .etx-n.new b{ font-weight:700; } .etx-n span{ display:block; color:var(--etx-muted); font-size:12.5px; margin-top:2px; } .etx-n small{ display:block; color:var(--etx-muted); font-size:11.5px; margin-top:4px; }",
    ".etx-menu{ padding:6px; } .etx-menu .who{ padding:10px 10px 12px; border-bottom:1px solid var(--etx-line); margin-bottom:4px; display:flex; gap:10px; align-items:center; } .etx-menu .who b{ display:block; } .etx-menu .who small{ color:var(--etx-muted); font-size:12px; }",
    ".etx-mi{ display:flex; width:100%; align-items:center; gap:10px; padding:9px 10px; border:0; background:none; color:inherit; font:inherit; font-size:13.5px; border-radius:8px; cursor:pointer; text-align:left; text-decoration:none; } .etx-mi:hover{ background:var(--etx-hover); }",
    ".etx-mi svg{ width:17px; height:17px; color:var(--etx-muted); } .etx-sep{ height:1px; background:var(--etx-line); margin:4px 6px; }",
    ".etx-veil{ position:fixed; inset:0; z-index:99990; background:rgba(15,15,15,.42); display:flex; align-items:flex-start; justify-content:center; padding:6vh 12px 12px; overflow:auto; }",
    ".etx-modal{ width:min(720px, 100%); background:var(--etx-panel); color:var(--etx-text); border-radius:16px; box-shadow:0 24px 70px rgba(0,0,0,.3); overflow:hidden; font:14px/1.4 -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; position:relative; }",
    ".etx-modal::before{ content:''; display:block; height:4px; background:linear-gradient(90deg,#FF0D07 0 64%,#808080 64% 86%,#B2B2B3 86%); }",
    ".etx-modal > header{ display:flex; align-items:center; gap:10px; padding:16px 18px 12px; } .etx-modal > header h3{ margin:0; font-size:17px; flex:1; }",
    ".etx-x{ width:32px; height:32px; border-radius:8px; border:0; background:none; color:var(--etx-muted); font-size:22px; line-height:1; cursor:pointer; } .etx-x:hover{ background:var(--etx-hover); }",
    ".etx-mb{ padding:0 18px 18px; } .etx-mf{ display:flex; gap:8px; justify-content:flex-end; padding:12px 18px; border-top:1px solid var(--etx-line); background:var(--etx-raised); flex-wrap:wrap; }",
    ".etx-btn{ height:36px; padding:0 14px; border-radius:9px; border:1px solid var(--etx-line); background:var(--etx-panel); color:var(--etx-text); font:600 13px/1 inherit; cursor:pointer; display:inline-flex; align-items:center; gap:7px; white-space:nowrap; }",
    ".etx-btn:hover{ background:var(--etx-hover); } .etx-btn.pri{ background:var(--etx-red); border-color:var(--etx-red); color:#fff; } .etx-btn.pri:hover{ filter:brightness(1.07); } .etx-btn:disabled{ opacity:.5; cursor:default; }",
    ".etx-btn.danger{ color:var(--etx-red); }",
    ".etx-in{ height:38px; padding:0 11px; border-radius:9px; border:1px solid var(--etx-line); background:var(--etx-panel); color:var(--etx-text); font:inherit; font-size:14px; width:100%; min-width:0; }",
    ".etx-in:focus{ outline:2px solid rgba(210,30,28,.35); border-color:var(--etx-red); }",
    ".etx-tabs{ display:flex; gap:4px; border-bottom:1px solid var(--etx-line); margin:0 -18px 12px; padding:0 18px; overflow-x:auto; }",
    ".etx-tab{ border:0; background:none; color:var(--etx-muted); font:600 13px/1 inherit; padding:10px 10px 11px; cursor:pointer; border-bottom:2px solid transparent; margin-bottom:-1px; white-space:nowrap; }",
    ".etx-tab.on{ color:var(--etx-text); border-bottom-color:var(--etx-red); }",
    ".etx-rows{ border:1px solid var(--etx-line); border-radius:12px; overflow:hidden; max-height:52vh; overflow-y:auto; }",
    ".etx-row{ display:flex; align-items:center; gap:12px; padding:11px 14px; border-bottom:1px solid var(--etx-line); cursor:pointer; width:100%; text-align:left; background:var(--etx-panel); border-left:0; border-right:0; border-top:0; color:inherit; font:inherit; }",
    ".etx-row:last-child{ border-bottom:0; } .etx-row:hover{ background:var(--etx-hover); } .etx-row .t{ flex:1; min-width:0; } .etx-row .t b{ display:block; font-size:14px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }",
    ".etx-row .t small{ display:block; color:var(--etx-muted); font-size:12px; margin-top:3px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; } .etx-row .r{ color:var(--etx-muted); font-size:12px; text-align:right; white-space:nowrap; }",
    ".etx-pill{ display:inline-block; font:700 10.5px/1 inherit; padding:4px 7px; border-radius:20px; background:var(--etx-raised); border:1px solid var(--etx-line); color:var(--etx-muted); margin-left:6px; vertical-align:1px; }",
    ".etx-pill.red{ background:rgba(210,30,28,.08); color:var(--etx-red); border-color:rgba(210,30,28,.25); } .etx-pill.green{ background:rgba(18,161,80,.1); color:#0f8a45; border-color:rgba(18,161,80,.3); }",
    ".etx-note{ color:var(--etx-muted); font-size:12.5px; margin:8px 0 0; }",
    ".etx-banner{ position:fixed; left:50%; transform:translateX(-50%); bottom:18px; z-index:99980; background:#1f1f1f; color:#fff; border-radius:12px; padding:10px 10px 10px 16px; display:flex; gap:12px; align-items:center; box-shadow:0 12px 34px rgba(0,0,0,.3); font:13.5px/1.35 -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width:calc(100vw - 24px); }",
    ".etx-banner .etx-btn{ height:32px; } .etx-toast{ position:fixed; left:50%; bottom:22px; transform:translateX(-50%); background:#1f1f1f; color:#fff; padding:10px 16px; border-radius:10px; z-index:100001; font:13.5px/1.3 -apple-system, BlinkMacSystemFont, sans-serif; box-shadow:0 10px 30px rgba(0,0,0,.25); max-width:calc(100vw - 24px); }",
    ".etx-share{ display:flex; gap:8px; margin-bottom:12px; flex-wrap:wrap; } .etx-share select{ flex:1; min-width:150px; }",
    ".etx-sel{ height:38px; border-radius:9px; border:1px solid var(--etx-line); background:var(--etx-panel); color:var(--etx-text); font:inherit; font-size:14px; padding:0 8px; }",
    "@media (max-width:1600px){ .appbar .etx-ib .lbl{ display:none; } .appbar .etx-chip .lbl{ max-width:96px; overflow:hidden; text-overflow:ellipsis; } }",
    "@media (max-width:1280px){ .appbar .etx-chip .lbl{ display:none; } }",
    "@media (max-width:820px){ .etx-ib .lbl{ display:none; } .etx-chip .lbl{ display:none; } }",
    "#stSetBox, #quoteOverlay .qt-set{ display:none !important; }",
  ].join("\n");
  function addCss(){ if (document.getElementById("etx-css")) return; var s = document.createElement("style"); s.id = "etx-css"; s.textContent = css; (document.head || document.documentElement).appendChild(s); }

  var IC = {
    bell:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.7 21a2 2 0 0 1-3.4 0"/></svg>',
    share:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="9" cy="8" r="3.2"/><path d="M3.5 20a5.5 5.5 0 0 1 11 0"/><path d="M18 8v6M15 11h6"/></svg>',
    home:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 11 12 4l9 7"/><path d="M5 10v10h14V10"/></svg>',
    folder:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>',
    phone:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="6" y="2" width="12" height="20" rx="2.5"/><path d="M10 18h4"/></svg>',
    pen:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/></svg>',
    shield:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>',
    spark:'<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 2l1.9 5.6L19.5 9.5l-5.6 1.9L12 17l-1.9-5.6L4.5 9.5l5.6-1.9z"/></svg>',
    out:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><path d="M16 17l5-5-5-5M21 12H9"/></svg>',
    user:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/></svg>',
  };
  E.icons = IC;

  /* ================= toast / modal / popover ================= */
  function toast(msg, ms){
    addCss();
    var t = document.createElement("div"); t.className = "etx etx-toast"; t.textContent = msg; document.body.appendChild(t);
    setTimeout(function(){ t.remove(); }, ms || 3200);
  }
  E.toast = toast;
  // modal({ title, html, buttons:[{label, kind, onClick(close)}], wide, onClose })
  function modal(o){
    addCss();
    var veil = document.createElement("div"); veil.className = "etx etx-veil";
    veil.innerHTML = '<div class="etx-modal" role="dialog" aria-modal="true"' + (o.width ? ' style="width:min(' + o.width + 'px,100%)"' : "") + '><header><h3>' + esc(o.title || "") + '</h3><button type="button" class="etx-x" aria-label="Close">&times;</button></header><div class="etx-mb"></div>' + (o.buttons && o.buttons.length ? '<div class="etx-mf"></div>' : "") + "</div>";
    var body = veil.querySelector(".etx-mb");
    if (typeof o.html === "string") body.innerHTML = o.html; else if (o.html) body.appendChild(o.html);
    function close(){ veil.remove(); document.removeEventListener("keydown", key, true); if (o.onClose) o.onClose(); }
    function key(e){ if (e.key === "Escape"){ e.stopPropagation(); close(); } }
    document.addEventListener("keydown", key, true);
    veil.querySelector(".etx-x").onclick = close;
    veil.addEventListener("mousedown", function(e){ if (e.target === veil) close(); });
    (o.buttons || []).forEach(function(b){
      var x = document.createElement("button"); x.type = "button"; x.className = "etx-btn" + (b.kind ? " " + b.kind : ""); x.textContent = b.label;
      x.onclick = function(){ b.onClick ? b.onClick(close, x) : close(); };
      veil.querySelector(".etx-mf").appendChild(x);
    });
    document.body.appendChild(veil);
    var f = veil.querySelector("[autofocus]"); if (f) setTimeout(function(){ f.focus(); }, 30);
    return { root:veil, body:body, close:close };
  }
  E.modal = modal;
  var openPop = null;
  function popover(anchor, build){
    addCss();
    if (openPop){ var was = openPop.anchor === anchor; openPop.close(); if (was) return null; }
    var p = document.createElement("div"); p.className = "etx etx-pop"; document.body.appendChild(p);
    build(p);
    var r = anchor.getBoundingClientRect(), w = p.offsetWidth;
    p.style.left = Math.max(8, Math.min(window.innerWidth - w - 8, r.right - w)) + "px";
    var top = r.bottom + 8; if (top + p.offsetHeight > window.innerHeight - 8) top = Math.max(8, window.innerHeight - p.offsetHeight - 8);
    p.style.top = top + "px";
    function away(e){ if (!p.contains(e.target) && !anchor.contains(e.target)) close(); }
    function key(e){ if (e.key === "Escape") close(); }
    function close(){ p.remove(); document.removeEventListener("mousedown", away, true); document.removeEventListener("touchstart", away, true); document.removeEventListener("keydown", key); openPop = null; }
    setTimeout(function(){ document.addEventListener("mousedown", away, true); document.addEventListener("touchstart", away, true); document.addEventListener("keydown", key); }, 0);
    openPop = { anchor:anchor, close:close, el:p };
    return openPop;
  }
  E.popover = popover;
  E.closePopover = function(){ if (openPop) openPop.close(); };

  /* ================= who is signed in, live updates ================= */
  var listeners = [];
  E.on = function(fn){ listeners.push(fn); };
  E.me = null;
  E.ready = fetch("/api/me", { credentials:"same-origin", cache:"no-store" }).then(function(r){ return r.ok ? r.json() : null; }).catch(function(){ return null; }).then(function(j){
    E.me = j ? j.user : null; E.config = j ? j.config : null; E.unread = j ? j.unread : 0;
    if (E.me && !E.me.mustChangePassword) connect();
    return E.me;
  });
  var es = null;
  function connect(){
    if (es || typeof EventSource === "undefined") return;
    es = new EventSource("/api/events");
    es.onmessage = function(m){ var ev; try { ev = JSON.parse(m.data); } catch(e){ return; }
      if (ev.type === "notify" || ev.type === "notify-read"){ E.unread = ev.unread; badges(); }
      listeners.forEach(function(fn){ try { fn(ev); } catch(e){ console.error(e); } }); };
    es.onerror = function(){ if (es && es.readyState === 2){ es = null; setTimeout(connect, 5000); } };
  }

  /* ================= the bell ================= */
  var bellBtns = [];
  function badges(){ bellBtns.forEach(function(b){ var x = b.querySelector(".etx-badge"); if (E.unread > 0){ if (!x){ x = document.createElement("span"); x.className = "etx-badge"; b.appendChild(x); } x.textContent = E.unread > 99 ? "99+" : E.unread; } else if (x) x.remove(); }); }
  function goTo(url){
    if (!url) return;
    var u = new URL(url, location.origin);
    if (PAGE === "planner" && u.pathname.replace(/index\.html$/, "") === "/app/" && u.searchParams.get("project") && E.openProject){ E.openProject(u.searchParams.get("project")); return; }
    if (u.pathname === location.pathname && u.hash !== location.hash){ location.href = u.href; location.reload(); return; }
    if (u.href !== location.href) location.href = u.href;
  }
  E.goTo = goTo;
  function bellPanel(anchor){
    popover(anchor, function(p){
      p.innerHTML = '<header><b>Notifications</b><button type="button" class="etx-link" data-all>Mark all read</button></header><div class="etx-list"><div class="etx-empty">Loading…</div></div>';
      var list = p.querySelector(".etx-list");
      function render(items){
        list.innerHTML = items.length ? items.map(function(n){ return '<button type="button" class="etx-n' + (n.read ? "" : " new") + '" data-id="' + n.id + '" data-url="' + esc(n.url) + '"><i class="dot"></i><div><b>' + esc(n.title) + "</b>" + (n.body ? "<span>" + esc(n.body) + "</span>" : "") + "<small>" + esc(ago(n.at)) + "</small></div></button>"; }).join("")
          : '<div class="etx-empty">Nothing yet. Shares, site reports and changes to your projects show here.</div>';
        list.querySelectorAll("[data-id]").forEach(function(b){ b.onclick = function(){ api("POST", "/api/notifications/read", { ids:[+b.dataset.id] }).catch(function(){}); if (openPop) openPop.close(); goTo(b.dataset.url); }; });
      }
      api("GET", "/api/notifications").then(function(j){ render(j.items); E.unread = j.unread; badges(); }).catch(function(e){ list.innerHTML = '<div class="etx-empty">' + esc(e.message) + "</div>"; });
      p.querySelector("[data-all]").onclick = function(){ api("POST", "/api/notifications/read", { all:true }).then(function(){ E.unread = 0; badges(); list.querySelectorAll(".etx-n.new").forEach(function(x){ x.classList.remove("new"); }); }); };
    });
  }
  E.bellButton = function(){
    addCss();
    var b = document.createElement("button"); b.type = "button"; b.className = "etx-ib etx-bell"; b.title = "Notifications"; b.setAttribute("aria-label", "Notifications"); b.innerHTML = IC.bell;
    b.onclick = function(){ bellPanel(b); };
    bellBtns.push(b); badges();
    return b;
  };
  E.on(function(ev){ if (ev.type === "notify" && ev.item && !(openPop && openPop.el.querySelector(".etx-list"))) { /* the badge is enough */ } });

  /* ================= phone / computer notifications (web push) ================= */
  function b64uToBytes(s){ s = s.replace(/-/g, "+").replace(/_/g, "/"); while (s.length % 4) s += "="; var r = atob(s), a = new Uint8Array(r.length); for (var i = 0; i < r.length; i++) a[i] = r.charCodeAt(i); return a; }
  E.pushSupported = function(){ return "serviceWorker" in navigator && "PushManager" in window && "Notification" in window; };
  E.enablePush = function(){
    if (!E.pushSupported()) return Promise.reject(new Error(/iPhone|iPad/.test(navigator.userAgent) ? "On iPhone / iPad: add the app to the Home Screen first (Share → Add to Home Screen), open it from there, then turn notifications on." : "This browser can’t show notifications."));
    return Notification.requestPermission().then(function(p){
      if (p !== "granted") throw new Error("Notifications are blocked for this site in the browser settings.");
      return navigator.serviceWorker.register("/push-sw.js", { scope:"/push/" });
    }).then(function(reg){ return navigator.serviceWorker.ready.then(function(){ return reg; }).catch(function(){ return reg; }); }).then(function(reg){
      return reg.pushManager.getSubscription().then(function(s){ return s || reg.pushManager.subscribe({ userVisibleOnly:true, applicationServerKey:b64uToBytes(E.config.pushKey) }); });
    }).then(function(sub){ return api("POST", "/api/push/subscribe", { subscription:sub.toJSON() }); });
  };

  /* ================= the person menu ================= */
  E.userButton = function(extra){
    addCss();
    var b = document.createElement("button"); b.type = "button"; b.className = "etx-avbtn"; b.title = E.me ? E.me.name : "";
    b.innerHTML = '<span class="etx-av">' + esc(initials(E.me && E.me.name)) + "</span>";
    b.onclick = function(){
      popover(b, function(p){
        var me = E.me, perms = me.perms, items = [];
        items.push(['<a class="etx-mi" href="/">' + IC.home + "Design Center home</a>"]);
        if (perms.design && PAGE !== "planner") items.push(['<a class="etx-mi" href="/app/">' + IC.pen + "LV Planner</a>"]);
        if (perms.design && PAGE === "planner") items.push(['<button type="button" class="etx-mi" data-k="projects">' + IC.folder + "My projects</button>"]);
        if ((perms.office || perms.site) && PAGE !== "site") items.push(['<a class="etx-mi" href="/app/site.html">' + IC.phone + "Site app</a>"]);
        (extra || []).forEach(function(x, i){ items.push(['<button type="button" class="etx-mi" data-x="' + i + '">' + x.icon + esc(x.label) + "</button>"]); });
        items.push(["sep"]);
        items.push(['<a class="etx-mi" href="/#account">' + IC.user + "My account &amp; notifications</a>"]);
        items.push(['<a class="etx-mi" href="/#claude">' + IC.spark + "Connect Claude</a>"]);
        if (perms.admin) items.push(['<a class="etx-mi" href="/#admin/users">' + IC.shield + "Admin</a>"]);
        items.push(["sep"]);
        items.push(['<button type="button" class="etx-mi" data-k="out">' + IC.out + "Sign out</button>"]);
        p.innerHTML = '<div class="etx-menu"><div class="who"><span class="etx-av">' + esc(initials(me.name)) + "</span><div><b>" + esc(me.name) + "</b><small>" + esc(describe(perms)) + "</small></div></div>" +
          items.map(function(i){ return i[0] === "sep" ? '<div class="etx-sep"></div>' : i[0]; }).join("") + "</div>";
        var pj = p.querySelector('[data-k="projects"]'); if (pj) pj.onclick = function(){ openPop.close(); E.openPicker && E.openPicker(); };
        p.querySelectorAll("[data-x]").forEach(function(x){ x.onclick = function(){ openPop.close(); extra[+x.dataset.x].onClick(); }; });
        p.querySelector('[data-k="out"]').onclick = function(){ api("POST", "/api/auth/logout").finally(function(){ location.href = "/login"; }); };
      });
    };
    return b;
  };
  var SITE_ROLE = { tech:"Technician", engineer:"Site engineer", manager:"Site manager" };
  function describe(p){ if (p.admin) return "Admin"; var b = []; if (p.design) b.push("Design Center"); if (p.office) b.push("Live projects office"); if (p.site) b.push(SITE_ROLE[p.site]); return b.join(" · ") || "No access yet"; }
  E.describe = describe;

  /* ================= sharing and versions (planner and home page) ================= */
  // project: { id, name, owner:{id,name}, access, siteId } ; onChange(shares)
  E.shareDialog = function(project, onChange){
    var me = E.me, people = [], shares = [];
    var m = modal({ title:"Share “" + project.name + "”", width:560, html:
      '<p style="margin:0 0 12px;color:var(--etx-muted)">People you share with see it in their projects (“shared by ' + esc(project.owner.name.split(" ")[0]) + '”). Changes anyone makes are saved for everyone' + (project.siteId ? " and the live site follows" : "") + ".</p>" +
      '<div class="etx-share"><select class="etx-sel" data-who></select><select class="etx-sel" data-can style="flex:0 0 auto;min-width:0"><option value="1">Can edit</option><option value="0">Can view</option></select><button type="button" class="etx-btn pri" data-add>Share</button></div>' +
      '<div class="etx-rows" data-list></div>' + (project.access === "view" ? '<p class="etx-note">You can view this project only.</p>' : ""),
      buttons:[{ label:"Done", kind:"pri" }] });
    var box = m.body.querySelector("[data-list]"), sel = m.body.querySelector("[data-who]");
    function render(){
      var row = function(name, sub, right){ return '<div class="etx-row" style="cursor:default"><span class="etx-av">' + esc(initials(name)) + '</span><div class="t"><b>' + esc(name) + "</b><small>" + esc(sub) + "</small></div>" + (right || "") + "</div>"; };
      var canManage = project.access !== "view";
      box.innerHTML = row(project.owner.name, "Owner") + shares.map(function(s){
        return row(s.name, s.canEdit ? "Can edit" : "Can view", canManage ? '<select class="etx-sel" data-perm="' + s.id + '" style="height:32px"><option value="1"' + (s.canEdit ? " selected" : "") + '>Can edit</option><option value="0"' + (s.canEdit ? "" : " selected") + '>Can view</option></select><button type="button" class="etx-x" data-rm="' + s.id + '" title="Stop sharing">&times;</button>' : "");
      }).join("");
      var taken = {}; taken[project.owner.id] = 1; shares.forEach(function(s){ taken[s.id] = 1; });
      var avail = people.filter(function(p){ return !taken[p.id] && p.design; });
      sel.innerHTML = avail.length ? '<option value="">Choose a person…</option>' + avail.map(function(p){ return '<option value="' + p.id + '">' + esc(p.name) + "</option>"; }).join("") : '<option value="">Everyone with Design Center access has it</option>';
      m.body.querySelector(".etx-share").style.display = canManage ? "" : "none";
      box.querySelectorAll("[data-perm]").forEach(function(s){ s.onchange = function(){ setShare(s.dataset.perm, s.value === "1"); }; });
      box.querySelectorAll("[data-rm]").forEach(function(b){ b.onclick = function(){ api("DELETE", "/api/dc/projects/" + project.id + "/shares/" + b.dataset.rm).then(done).catch(function(e){ toast(e.message); }); }; });
    }
    function done(j){ shares = j.shares; if (onChange) onChange(shares); render(); }
    function setShare(uid, canEdit){ return api("PUT", "/api/dc/projects/" + project.id + "/shares/" + uid, { canEdit:canEdit }).then(done).catch(function(e){ toast(e.message); }); }
    m.body.querySelector("[data-add]").onclick = function(){ if (!sel.value) { sel.focus(); return; } var n = sel.options[sel.selectedIndex].text; setShare(sel.value, m.body.querySelector("[data-can]").value === "1").then(function(){ toast("Shared with " + n + " — they got a notification"); }); };
    Promise.all([api("GET", "/api/users"), api("GET", "/api/dc/projects/" + project.id + "/shares")]).then(function(r){ people = r[0].users.filter(function(u){ return u.id !== me.id; }); shares = r[1].shares; render(); })
      .catch(function(e){ box.innerHTML = '<div class="etx-empty">' + esc(e.message) + "</div>"; });
    return m;
  };
  E.versionsDialog = function(project, onRestored){
    var m = modal({ title:"Versions of “" + project.name + "”", width:560, html:'<div class="etx-rows" data-list><div class="etx-empty">Loading…</div></div><p class="etx-note">A version is kept about every 20 minutes of work, and every time someone else saves.</p>' });
    var box = m.body.querySelector("[data-list]");
    api("GET", "/api/dc/projects/" + project.id + "/versions").then(function(j){
      box.innerHTML = j.versions.map(function(v){ return '<div class="etx-row" style="cursor:default"><div class="t"><b>' + esc(new Date(v.savedAt).toLocaleString(undefined, { day:"numeric", month:"short", hour:"2-digit", minute:"2-digit" })) + (v.current ? '<span class="etx-pill red">current</span>' : "") + "</b><small>" + esc(v.savedBy || "") + " · " + v.points + " points" + (v.reason ? " · " + esc(v.reason) : "") + "</small></div>" + (v.current || project.access === "view" ? "" : '<button type="button" class="etx-btn" data-v="' + v.id + '">Restore</button>') + "</div>"; }).join("");
      box.querySelectorAll("[data-v]").forEach(function(b){ b.onclick = function(){ b.disabled = true; api("POST", "/api/dc/projects/" + project.id + "/versions/" + b.dataset.v + "/restore").then(function(){ m.close(); toast("Restored — the version before it stays in the list"); if (onRestored) onRestored(); }).catch(function(e){ b.disabled = false; toast(e.message); }); }; });
    }).catch(function(e){ box.innerHTML = '<div class="etx-empty">' + esc(e.message) + "</div>"; });
    return m;
  };

  /* ================= site app ================= */
  if (PAGE === "site"){
    // a customer or team link (k=…) is not about the signed-in person: leave it as it is
    var personal = !/(^|[#&])k=/.test(location.hash);
    document.addEventListener("DOMContentLoaded", function(){
      E.ready.then(function(me){
        if (!me || !personal) return;
        var top = document.querySelector("header.top"), role = document.getElementById("roleTag");
        if (!top) return;
        addCss();
        var bar = document.createElement("div"); bar.className = "etx etx-bar"; bar.style.marginLeft = "4px";
        bar.appendChild(E.bellButton()); bar.appendChild(E.userButton());
        if (role && role.nextSibling) top.insertBefore(bar, role.nextSibling); else top.appendChild(bar);
      });
    });
  }

  /* ================= the planner ================= */
  // Called by the planner at the end of its start-up with the few things this needs (L).
  E.planner = function(L){
    addCss();
    var me = null, cur = null, pending = null, known = {}, hashes = {};
    var S = { saving:null, again:false, dirtySince:0, lastTry:0, blocked:null, siteTimer:null, others:[] };
    var chip, whoBox, shareBtn;

    /* --- drawings: fingerprint (SHA-256) and upload once --- */
    function b64ToBytes(b64){ return fetch("data:application/pdf;base64," + b64).then(function(r){ return r.arrayBuffer(); }); }
    function blobToB64(blob){ return new Promise(function(res, rej){ var fr = new FileReader(); fr.onload = function(){ var s = String(fr.result); res(s.slice(s.indexOf(",") + 1)); }; fr.onerror = function(){ rej(fr.error); }; fr.readAsDataURL(blob); }); }
    function hex(buf){ return Array.prototype.map.call(new Uint8Array(buf), function(x){ return ("0" + x.toString(16)).slice(-2); }).join(""); }
    function hashOf(fid, b64){
      var c = hashes[fid]; if (c && c.b64 === b64) return Promise.resolve({ hash:c.hash, bytes:null });
      return b64ToBytes(b64).then(function(buf){ return crypto.subtle.digest("SHA-256", buf).then(function(d){ var h = hex(d); hashes[fid] = { b64:b64, hash:h }; return { hash:h, bytes:buf }; }); });
    }
    function ensureBlob(h, bytes, b64){
      if (known[h]) return Promise.resolve();
      return fetch("/api/dc/blobs/" + h, { method:"HEAD", credentials:"same-origin" }).then(function(r){
        if (r.ok){ known[h] = 1; return; }
        return (bytes ? Promise.resolve(bytes) : b64ToBytes(b64)).then(function(buf){
          setChip("saving", "Uploading drawing…");
          return fetch("/api/dc/blobs/" + h, { method:"PUT", credentials:"same-origin", headers:{ "X-Express":"1", "Content-Type":"application/pdf" }, body:buf });
        }).then(function(r2){ if (!r2.ok) return r2.json().catch(function(){ return {}; }).then(function(j){ throw new Error(j.error || "The drawing could not be uploaded"); }); known[h] = 1; });
      });
    }
    function payload(){
      var obj = L.projectObject();
      return Promise.all(obj.floors.map(function(f){
        if (!f.pdfBase64) return null;
        var b64 = f.pdfBase64;
        return hashOf(f.id, b64).then(function(r){ return ensureBlob(r.hash, r.bytes, b64).then(function(){ f.pdfRef = r.hash; f.pdfBase64 = null; }); });
      })).then(function(){ return obj; });
    }
    function gz(obj){
      var text = JSON.stringify(obj);
      if (typeof CompressionStream === "undefined" || text.length < 20000) return Promise.resolve({ body:text, headers:{ "Content-Type":"application/json" } });
      return new Response(new Blob([text]).stream().pipeThrough(new CompressionStream("gzip"))).arrayBuffer()
        .then(function(b){ return { body:b, headers:{ "Content-Type":"application/json", "Content-Encoding":"gzip" } }; });
    }

    /* --- the status chip next to Save --- */
    function setChip(kind, text){
      if (!chip) return;
      chip.className = "etx-chip" + (kind === "saving" ? " saving" : kind === "bad" ? " bad" : "");
      chip.innerHTML = "<i></i><span class=\"lbl\">" + esc(text) + "</span>";
      chip.title = kind === "bad" ? text + " — tap to try again" : text;
    }
    function savedChip(){
      if (!cur) { setChip("", L.hasContent() ? "Not saved yet" : "Your projects are saved online"); if (L.hasContent()) chip.className = "etx-chip saving"; return; }
      if (S.blocked === "view") return setChip("bad", "View only");
      setChip("", "Saved " + ago(S.savedAt || cur.updatedAt) + (cur.owner && me && cur.owner.id !== me.id ? " · shared by " + cur.owner.name.split(" ")[0] : ""));
    }
    setInterval(function(){ if (!S.saving && !S.blocked && cur && !L.isDirty()) savedChip(); }, 30000);

    /* --- saving --- */
    function save(manual){
      if (S.saving){ S.again = S.again || manual; return S.saving; }
      if (!me || S.opening) return Promise.resolve(false);
      if (S.blocked === "view"){ if (manual) toast(cur.owner.name + " shared this project with you to view only — use Save a copy."); return Promise.resolve(false); }
      if (S.blocked === "conflict"){ if (manual) conflict(S.conflict); return Promise.resolve(false); }
      if (!L.hasName()){ if (manual) L.requireName(); return Promise.resolve(false); }
      if (!manual && !L.isDirty() && cur) return Promise.resolve(true);
      var sig = L.stateSig(), was = cur;
      S.lastTry = Date.now();
      setChip("saving", "Saving…");
      S.saving = payload().then(function(obj){
        return gz(cur ? { data:obj, baseVersion:cur.version } : { data:obj }).then(function(g){
          return fetch(cur ? "/api/dc/projects/" + cur.id : "/api/dc/projects", { method:cur ? "PUT" : "POST", credentials:"same-origin", headers:Object.assign({ "X-Express":"1", "X-Client":E.clientId }, g.headers), body:g.body });
        }).then(function(r){ return r.json().catch(function(){ return {}; }).then(function(j){ if (!r.ok){ var e = new Error(j.error || ("Error " + r.status)); e.status = r.status; e.data = j; throw e; } return j; }); });
      }).then(function(j){
        if (cur && was && cur.id !== was.id) return false;   // another project was opened meanwhile
        cur = j.project; S.savedAt = Date.now(); S.dirtySince = 0;
        L.markSaved(sig); remember(); savedChip(); updateShare(); heartbeat();
        if (manual) L.status("Saved to your Design Center projects");
        siteAfterSave(manual);
        return true;
      }).catch(function(e){
        if (e.status === 409 && e.data && e.data.conflict && S.opening) return false;   // the newer version is being opened right now
        if (e.status === 409 && e.data && e.data.conflict){ S.blocked = "conflict"; S.conflict = e.data.conflict; setChip("bad", "Changed by " + e.data.conflict.updatedBy); conflict(e.data.conflict); return false; }
        if (e.status === 409 && e.data && e.data.missingDrawing){ delete known[e.data.missingDrawing]; S.again = true; return false; }
        if (e.status === 403 && /view only/i.test(e.message)){ S.blocked = "view"; savedChip(); if (manual) toast(e.message); return false; }
        if (e.status === 401){ setChip("bad", "Signed out — sign in again"); if (manual) location.href = "/login?next=" + encodeURIComponent(location.pathname + location.search); return false; }
        if (e.status === 404 && cur){ toast("This project was deleted or is not shared with you any more — it will be saved as a new project."); cur = null; S.again = true; return false; }
        setChip("bad", navigator.onLine === false ? "Offline — not saved yet" : "Not saved: " + e.message);
        if (manual) L.status("Couldn't save: " + e.message);
        return false;
      }).finally(function(){ S.saving = null; if (S.again){ S.again = false; setTimeout(function(){ save(false); }, 400); } });
      return S.saving;
    }
    function tick(){
      if (!me || S.opening || !L.hasContent()) { if (chip && !cur && !S.opening) savedChip(); return; }
      if (!L.isDirty()){ S.dirtySince = 0; return; }
      if (!S.dirtySince) S.dirtySince = Date.now();
      if (S.saving || S.blocked || !L.hasName()) { if (!L.hasName() && chip) setChip("saving", "Type the customer name to save"); return; }
      var quiet = Date.now() - S.dirtySince;
      if (quiet > 2500 || Date.now() - S.lastTry > 20000) save(false);
      else setChip("saving", "Unsaved changes");
    }
    setInterval(tick, 2000);
    window.addEventListener("online", function(){ if (L.isDirty()) save(false); });
    document.addEventListener("visibilitychange", function(){ if (document.visibilityState === "hidden" && L.isDirty() && !S.blocked) save(false); });
    window.addEventListener("beforeunload", function(e){ if (L.isDirty() && L.hasContent() && !S.blocked){ save(false); e.preventDefault(); e.returnValue = ""; } });

    /* --- the live site follows the design: right away on Save, otherwise after a quiet minute --- */
    function siteAfterSave(manual){
      if (!L.siteId() || !me.perms.office) return;
      clearTimeout(S.siteTimer);
      if (manual) { L.publishSite(); return; }
      S.siteTimer = setTimeout(function(){ if (!L.isDirty()) L.publishSite(); }, 60000);
    }

    /* --- someone else saved first --- */
    function conflict(c){
      var when = c.updatedAt ? new Date(c.updatedAt).toLocaleTimeString(undefined, { hour:"2-digit", minute:"2-digit" }) : "";
      var self = c.updatedById && c.updatedById === me.id, first = self ? "the other device" : c.updatedBy.split(" ")[0];
      L.ask({ title:self ? "This project was saved on another device" : c.updatedBy + " changed this project",
        message:(self ? "You saved a newer version on another device" : c.updatedBy + " saved a newer version") + (when ? " at " + when : "") + " while this copy was open. What should happen with the changes here?",
        buttons:[{ label:self ? "Open the newer version" : "Open " + first + "’s version", value:"theirs", kind:"primary", sub:"The changes here since then are dropped" },
                 { label:"Keep these changes", value:"mine", sub:"Replaces " + (self ? "the other device’s" : first + "’s") + " version (it stays in Versions)" },
                 { label:"Save mine as a copy", value:"copy", sub:"Both versions stay" }] },
        function(v){
          if (v === "theirs"){ S.blocked = null; openProject(cur.id, { force:true }); }
          else if (v === "mine"){ S.blocked = null; forceSave(); }
          else if (v === "copy"){ S.blocked = null; cur = null; L.renameTo(L.name() + " (copy)"); save(true); }
        });
    }
    function forceSave(){
      var sig = L.stateSig();
      setChip("saving", "Saving…");
      payload().then(function(obj){ return api("PUT", "/api/dc/projects/" + cur.id, { data:obj, baseVersion:cur.version, force:true }, { headers:{ "X-Client":E.clientId } }); })
        .then(function(j){ cur = j.project; S.savedAt = Date.now(); L.markSaved(sig); savedChip(); L.status("Saved — your version is the current one"); siteAfterSave(true); })
        .catch(function(e){ setChip("bad", "Not saved: " + e.message); });
    }

    /* --- opening --- */
    function openProject(id, opts){
      opts = opts || {};
      if (!opts.force && L.isDirty() && L.hasContent() && !(cur && cur.id === id)) { L.guard(function(){ openProject(id, { force:true }); }, "opening another project"); return; }
      L.status("Opening the project…");
      S.opening = true;
      return api("GET", "/api/dc/projects/" + encodeURIComponent(id)).then(function(j){
        var data = j.data, floors = data.floors || [], keep = opts.keepFloor;
        return Promise.all(floors.map(function(f){
          if (!f.pdfRef) return null;
          return fetch("/api/dc/blobs/" + f.pdfRef, { credentials:"same-origin" }).then(function(r){ if (!r.ok) throw new Error("A floor drawing is missing on the server (" + (f.name || "") + ")"); return r.blob(); })
            .then(blobToB64).then(function(b64){ f.pdfBase64 = b64; hashes[f.id] = { b64:b64, hash:f.pdfRef }; known[f.pdfRef] = 1; });
        })).then(function(){
          pending = { data:data, project:j.project };
          return L.load(data);
        }).then(function(){
          if (keep != null) L.setFloor(keep);
          if (opts.quiet) L.status(/^you/.test(opts.quiet) ? "Updated with what you saved on another device" : "Updated with " + opts.quiet + "’s changes");
          else L.status("Opened “" + j.project.name + "”" + (j.project.owner.id !== me.id ? " — shared by " + j.project.owner.name : ""));
        });
      }).catch(function(e){ L.status("Couldn't open it: " + e.message); toast(e.message); }).finally(function(){ S.opening = false; });
    }
    E.openProject = function(id){ openProject(id); };
    // the planner calls this after every load (a cloud project, a file from this device, a new project)
    E.loaded = function(parsed){
      if (pending && pending.data === parsed){ cur = pending.project; S.blocked = cur.access === "view" ? "view" : null; }
      else { cur = null; S.blocked = null; }
      pending = null; S.dirtySince = 0; S.savedAt = cur ? Date.parse(cur.updatedAt) : 0;
      var u = new URL(location.href);
      if (cur) u.searchParams.set("project", cur.id); else u.searchParams.delete("project");
      u.searchParams.delete("new");
      history.replaceState(null, "", u.pathname + u.search);
      remember(); savedChip(); updateShare(); heartbeat(true);
    };
    function remember(){ try { if (cur) localStorage.setItem("etx_last_project", cur.id); } catch(e){} }

    /* --- live: someone else saved this project --- */
    var banner = null;
    function showBanner(text, btn, fn){
      if (banner) banner.remove();
      banner = document.createElement("div"); banner.className = "etx etx-banner";
      banner.innerHTML = "<span>" + esc(text) + '</span><button type="button" class="etx-btn pri">' + esc(btn) + '</button><button type="button" class="etx-x" style="color:#bbb" aria-label="Close">&times;</button>';
      banner.querySelector(".etx-btn").onclick = function(){ banner.remove(); banner = null; fn(); };
      banner.querySelector(".etx-x").onclick = function(){ banner.remove(); banner = null; };
      document.body.appendChild(banner);
    }
    E.on(function(ev){
      if (ev.type !== "dc" || !cur || ev.id !== cur.id || ev.client === E.clientId || ev.version <= cur.version) return;
      var who = ev.by === me.id ? "you (on another device)" : ev.byName.split(" ")[0];
      if (!L.isDirty() && !S.saving) openProject(cur.id, { force:true, keepFloor:L.floorIndex(), quiet:who });
      else showBanner((ev.by === me.id ? "You saved this project on another device." : ev.byName + " saved changes to this project."), "Load them", function(){ conflict({ updatedBy:ev.byName, updatedById:ev.by, updatedAt:new Date().toISOString() }); });
    });

    /* --- who else has it open --- */
    function heartbeat(now){
      clearTimeout(heartbeat.t);
      if (!cur){ renderWho([]); return; }
      var id = cur.id;
      api("POST", "/api/dc/projects/" + id + "/presence", { editing:L.isDirty() }).then(function(j){ if (cur && cur.id === id) renderWho(j.others); }).catch(function(){});
      heartbeat.t = setTimeout(heartbeat, 30000);
    }
    function renderWho(list){
      if (!whoBox) return;
      S.others = list || [];
      whoBox.innerHTML = S.others.map(function(o){ return '<span class="etx-av" title="' + esc(o.name) + ' has this project open">' + esc(initials(o.name)) + "</span>"; }).join("");
      whoBox.style.display = S.others.length ? "" : "none";
    }
    window.addEventListener("pagehide", function(){ if (cur) fetch("/api/dc/projects/" + cur.id + "/presence", { method:"DELETE", headers:{ "X-Express":"1" }, keepalive:true, credentials:"same-origin" }).catch(function(){}); });

    /* --- the project list --- */
    function openPicker(){
      var scope = "", list = [], q = "";
      var tabs = [["", "All my projects"], ["mine", "Mine"], ["shared", "Shared with me"]];
      if (me.perms.allDesigns) tabs.push(["all", "Everyone’s"]);
      var m = modal({ title:"Projects", width:760, html:
        '<div class="etx-tabs">' + tabs.map(function(t){ return '<button type="button" class="etx-tab' + (t[0] === scope ? " on" : "") + '" data-s="' + t[0] + '">' + t[1] + "</button>"; }).join("") + "</div>" +
        '<div style="display:flex;gap:8px;margin-bottom:12px;flex-wrap:wrap"><input class="etx-in" style="flex:1;min-width:180px" placeholder="Search by customer name" data-q autofocus>' +
        '<button type="button" class="etx-btn pri" data-new>+ New project</button><button type="button" class="etx-btn" data-file>Open a file from this device</button></div>' +
        '<div class="etx-rows" data-list><div class="etx-empty">Loading…</div></div>' +
        '<p class="etx-note">Projects save by themselves while you work and open the same on every device. Share one with the button next to Save.</p>' });
      var box = m.body.querySelector("[data-list]");
      function render(){
        var rows = list.filter(function(p){ return !q || p.name.toLowerCase().indexOf(q) >= 0; });
        box.innerHTML = rows.length ? rows.map(function(p){
          var mine = p.owner.id === me.id, open = cur && cur.id === p.id;
          return '<button type="button" class="etx-row" data-id="' + p.id + '"><div class="t"><b>' + esc(p.name) + (open ? '<span class="etx-pill red">open</span>' : "") + (p.siteId ? '<span class="etx-pill green">live</span>' : "") + "</b><small>" +
            (mine ? (p.sharedWith.length ? "Shared with " + esc(p.sharedWith.map(function(s){ return s.name.split(" ")[0]; }).join(", ")) : "Only you") : "Shared by " + esc(p.owner.name)) +
            " · " + p.points + " point" + (p.points === 1 ? "" : "s") + " · " + p.floors + " floor" + (p.floors === 1 ? "" : "s") + "</small></div>" +
            '<div class="r">' + esc(ago(p.updatedAt)) + "<br>" + esc(p.updatedBy.name ? "by " + p.updatedBy.name.split(" ")[0] : "") + "</div></button>";
        }).join("") : '<div class="etx-empty">' + (q ? "No project matches “" + esc(q) + "”." : scope === "shared" ? "Nothing is shared with you yet." : "No projects yet — press New project.") + "</div>";
        box.querySelectorAll("[data-id]").forEach(function(b){ b.onclick = function(){ m.close(); if (!(cur && cur.id === b.dataset.id)) openProject(b.dataset.id); }; });
      }
      function load(){ box.innerHTML = '<div class="etx-empty">Loading…</div>'; api("GET", "/api/dc/projects?scope=" + scope).then(function(j){ list = j.projects; render(); }).catch(function(e){ box.innerHTML = '<div class="etx-empty">' + esc(e.message) + "</div>"; }); }
      m.body.querySelectorAll("[data-s]").forEach(function(b){ b.onclick = function(){ scope = b.dataset.s; m.body.querySelectorAll("[data-s]").forEach(function(x){ x.classList.toggle("on", x === b); }); load(); }; });
      m.body.querySelector("[data-q]").oninput = function(e){ q = e.target.value.trim().toLowerCase(); render(); };
      m.body.querySelector("[data-new]").onclick = function(){ m.close(); L.startNew(); };
      m.body.querySelector("[data-file]").onclick = function(){ m.close(); L.openFile(); };
      load();
    }
    E.openPicker = openPicker;

    /* --- sharing --- */
    function updateShare(){
      if (!shareBtn) return;
      shareBtn.querySelector(".lbl").textContent = cur && cur.sharedWith && cur.sharedWith.length ? "Shared · " + (cur.sharedWith.length + (cur.owner.id !== me.id ? 1 : 0)) : "Share";
    }
    function openShare(){
      if (!cur){
        if (!L.hasName()) { L.requireName(); return; }
        L.status("Saving the project first…");
        save(true).then(function(ok){ if (ok && cur) openShare(); });
        return;
      }
      E.shareDialog(cur, function(shares){ cur.sharedWith = shares; updateShare(); });
    }
    function openVersions(){
      if (!cur) { toast("Save the project first."); return; }
      E.versionsDialog(cur, function(){ openProject(cur.id, { force:true }); });
    }
    E.openVersions = openVersions;

    /* --- the toolbar: status · who else · Share · bell · me --- */
    function mount(){
      var bar = document.querySelector(".appbar"), anchor = document.getElementById("themeToggleBtn");
      if (!bar) return;
      var box = document.createElement("div"); box.className = "etx etx-bar";
      chip = document.createElement("span"); chip.className = "etx-chip"; chip.onclick = function(){ if (chip.classList.contains("bad")) { if (S.blocked === "conflict") conflict(S.conflict); else save(true); } };
      whoBox = document.createElement("span"); whoBox.className = "etx-who"; whoBox.style.display = "none";
      shareBtn = document.createElement("button"); shareBtn.type = "button"; shareBtn.className = "etx-ib"; shareBtn.title = "Share this project"; shareBtn.innerHTML = IC.share + '<span class="lbl">Share</span>'; shareBtn.onclick = openShare;
      box.appendChild(chip); box.appendChild(whoBox); box.appendChild(shareBtn); box.appendChild(E.bellButton());
      box.appendChild(E.userButton([{ icon:IC.folder, label:"Versions of this project", onClick:openVersions }]));
      bar.insertBefore(box, anchor || null);
      var open = document.getElementById("loadProjectBtn"); if (open) { open.title = "Your projects"; var l = open.querySelector(".tlabel"); if (l) l.textContent = "Projects"; }
      savedChip();
    }

    E.ready.then(function(u){
      me = u;
      if (!me) { location.href = "/login?next=" + encodeURIComponent(location.pathname + location.search); return; }
      mount();
      var q = new URLSearchParams(location.search);
      if (q.get("project")) openProject(q.get("project"), { force:true });
      else if (q.get("new")) L.startNew();
      else if (q.get("site")) openBySite(q.get("site"));
      else setTimeout(function(){ if (!L.hasContent() && !document.querySelector(".restore-card.on")) openPicker(); }, 900);
    });
    function openBySite(siteId){
      api("GET", "/api/dc/by-site/" + encodeURIComponent(siteId)).then(function(j){
        if (j.projects.length) openProject(j.projects[0].id, { force:!L.hasContent() });
        else { toast("No Design Center project you can open is linked to this live project yet. Ask its owner to share it with you."); if (!L.hasContent()) openPicker(); }
      }).catch(function(e){ toast(e.message); });
    }
    return { save:save, tick:tick, openPicker:openPicker, openBySite:openBySite };
  };
})();
