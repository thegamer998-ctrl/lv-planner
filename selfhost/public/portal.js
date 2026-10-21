/* Express Tech Design Center — the home page: projects, live projects, notifications, account, Connect Claude, Admin.
   Also the front door for customers: design.expresskw.com/#<project>-<key> opens that project's live progress. */
(function(){
  "use strict";
  var E = window.EXPRESS, api = E.api, esc = E.esc, ago = E.ago, modal = E.modal, toast = E.toast, IC = E.icons;
  var root = document.getElementById("root");

  /* ---------- the customer's link: /#<project>-<view key> ---------- */
  var code = decodeURIComponent(location.hash.slice(1) || "").trim(), cm = code.match(/^([A-Za-z0-9]{6,32})-([A-Za-z0-9]{8,64})$/);
  if (cm){
    try { localStorage.setItem("et_dc_code", code); } catch(e){}
    var f = document.createElement("iframe");
    f.className = "client"; f.title = "Express Tech Design Center"; f.allow = "fullscreen; camera";
    f.src = "/app/site.html#p=" + cm[1] + "&k=" + cm[2] + "&s=" + encodeURIComponent(location.origin);
    document.body.appendChild(f);
    window.addEventListener("hashchange", function(){ location.reload(); });
    return;
  }

  var me = null, cfg = null;
  E.ready.then(function(u){
    if (!u){
      // a customer who opened their link before and comes back without it
      var last = null; try { last = localStorage.getItem("et_dc_code"); } catch(e){}
      if (last && /^[A-Za-z0-9]{6,32}-[A-Za-z0-9]{8,64}$/.test(last) && !location.hash){ location.replace("/#" + last); location.reload(); return; }
      location.replace("/login?next=" + encodeURIComponent("/" + location.hash)); return;
    }
    if (u.mustChangePassword){ location.replace("/login?next=" + encodeURIComponent("/" + location.hash)); return; }
    me = u; cfg = E.config;
    shell(); route();
    window.addEventListener("hashchange", route);
    E.on(function(ev){
      if (ev.type === "me"){ api("GET", "/api/me").then(function(j){ me = E.me = j.user; shell(); route(); }); }
      if ((ev.type === "dc-list" || ev.type === "dc") && /^(home|projects)/.test(cur)) route(true);
      if (ev.type === "notify" && /^(home|notifications)/.test(cur)) route(true);
    });
  });

  /* ---------- page frame ---------- */
  var cur = "";
  function nav(){
    var p = me.perms, items = [["home", "Home"]];
    if (p.design) items.push(["projects", "Projects"]);
    if (p.office || p.site) items.push(["live", "Live projects"]);
    items.push(["notifications", "Notifications"]);
    if (p.admin) items.push(["admin/users", "Admin"]);
    return items;
  }
  function shell(){
    root.innerHTML = '<header class="top"><div class="top-in"><a class="logo" href="/#home"><img src="/brand-logo.png" alt="Express Tech — We help you grow"><span>Design Center</span></a>' +
      '<nav class="nav" id="nav">' + nav().map(function(n){ return '<a href="#' + n[0] + '" data-n="' + n[0].split("/")[0] + '">' + n[1] + "</a>"; }).join("") + "</nav>" +
      '<div class="etx etx-bar" id="bar"></div></div></header><main class="page" id="page"></main>';
    var bar = document.getElementById("bar");
    bar.appendChild(E.bellButton()); bar.appendChild(E.userButton());
  }
  function route(soft){
    var h = (location.hash || "#home").slice(1).split("?")[0] || "home";
    cur = h;
    document.querySelectorAll("#nav a").forEach(function(a){ a.classList.toggle("on", h.split("/")[0] === a.dataset.n); });
    var page = document.getElementById("page");
    var name = h.split("/")[0], sub = h.split("/")[1] || "";
    var fn = { home:home, projects:projects, live:live, notifications:notifications, account:account, claude:claude, admin:admin }[name] || home;
    if (!soft) { page.innerHTML = '<div class="empty">Loading…</div>'; window.scrollTo(0, 0); }
    fn(page, sub, soft);
  }
  function hq(k){ var m = location.hash.match(new RegExp("[?&]" + k + "=([^&]*)")); return m ? decodeURIComponent(m[1]) : null; }
  function err(page, e){ page.innerHTML = '<div class="notice red">' + esc(e.message) + "</div>"; }
  function copy(text, msg){ (navigator.clipboard ? navigator.clipboard.writeText(text) : Promise.reject()).then(function(){ toast(msg || "Copied"); }, function(){ window.prompt("Copy this:", text); }); }
  function greet(){ var h = new Date().getHours(); return h < 12 ? "Good morning" : h < 17 ? "Good afternoon" : "Good evening"; }
  var SVG = {
    pen:IC.pen, phone:IC.phone, shield:IC.shield, spark:IC.spark, folder:IC.folder, bell:IC.bell,
    plus:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>',
    dots:'<svg viewBox="0 0 24 24" fill="currentColor"><circle cx="5" cy="12" r="1.8"/><circle cx="12" cy="12" r="1.8"/><circle cx="19" cy="12" r="1.8"/></svg>',
  };
  function projRow(p){
    var mine = p.owner.id === me.id;
    return '<a class="row" href="/app/?project=' + p.id + '"><span class="av" style="background:' + (mine ? "#2b2b2b" : "#808080") + '">' + esc(E.initials(p.name)) + '</span><div class="t"><b>' + esc(p.name) + (p.siteId ? '<span class="pill green">live</span>' : "") + "</b><small>" +
      (mine ? (p.sharedWith.length ? "Shared with " + esc(p.sharedWith.map(function(s){ return s.name.split(" ")[0]; }).join(", ")) : "Only you") : "Shared by " + esc(p.owner.name)) + " · " + p.points + " points</small></div>" +
      '<div class="r">' + esc(ago(p.updatedAt)) + "<br>" + esc(p.updatedBy.name ? "by " + p.updatedBy.name.split(" ")[0] : "") + "</div></a>";
  }
  function liveRow(p){
    return '<a class="row" href="/app/site.html#p=' + p.id + '"><div class="t"><b>' + esc(p.name) + (p.paused ? '<span class="pill amber">paused</span>' : p.state === "done" ? '<span class="pill green">completed</span>' : "") + (p.openReports ? '<span class="pill red">' + p.openReports + " report" + (p.openReports > 1 ? "s" : "") + "</span>" : "") + "</b><small>" +
      (p.nextStage ? "Next: " + esc(p.nextStage) : p.points + " points") + '</small></div><div class="bar' + (p.pct === 100 ? " ok" : "") + '"><i style="width:' + p.pct + '%"></i></div><div class="r" style="min-width:38px">' + p.pct + "%</div></a>";
  }

  /* ---------- Home ---------- */
  function home(page){
    var p = me.perms;
    var tiles = [];
    if (p.design) tiles.push('<a class="card tile dark" href="/app/"><span class="ic">' + SVG.pen + "</span><b>LV Planner</b><small>Design villas, reports, quotes. Your projects open on every device.</small></a>");
    if (p.office || p.site) tiles.push('<a class="card tile" href="/app/site.html"><span class="ic">' + SVG.phone + "</span><b>Site app</b><small>" + (p.office ? "Every live project — progress, reports, photos." : "Your projects on site — tick, photograph, report.") + "</small></a>");
    if (p.admin) tiles.push('<a class="card tile" href="#admin/users"><span class="ic">' + SVG.shield + "</span><b>Admin</b><small>Logins &amp; permissions, integrations, system.</small></a>");
    tiles.push('<a class="card tile" href="#claude"><span class="ic">' + SVG.spark + "</span><b>Connect Claude</b><small>Use your projects from your own Claude app.</small></a>");
    page.innerHTML = (hq("no") === "design" || location.search.indexOf("no=design") >= 0 ? '<div class="notice">Your login has no Design Center access. Ask an admin if you need the planner.</div>' : "") +
      '<div class="hello"><div><h1>' + greet() + ", " + esc(me.firstName) + '</h1><p>' + esc(E.describe(p)) + " · " + new Date().toLocaleDateString(undefined, { weekday:"long", day:"numeric", month:"long" }) + "</p></div>" +
      '<div class="acts">' + (p.design ? '<a class="btn pri" href="/app/?new=1">' + SVG.plus + "New project</a>" : "") + "</div></div>" +
      '<div class="grid">' + tiles.join("") + "</div>" +
      '<div class="two" style="margin-top:6px">' +
        (p.design ? '<section><h2 class="sec">Recent projects <a class="btn ghost sm" href="#projects">All projects</a></h2><div class="card list" id="hRecent"><div class="empty">Loading…</div></div></section>' : "") +
        (p.office || p.site ? '<section><h2 class="sec">Live projects <a class="btn ghost sm" href="#live">All</a></h2><div class="card list" id="hLive"><div class="empty">Loading…</div></div></section>' : "") +
        '<section><h2 class="sec">Notifications <a class="btn ghost sm" href="#notifications">All</a></h2><div class="card list" id="hNote"><div class="empty">Loading…</div></div></section>' +
      "</div>";
    if (p.design) api("GET", "/api/dc/projects").then(function(j){ var el = document.getElementById("hRecent"); if (!el) return;
      el.innerHTML = j.projects.slice(0, 6).map(projRow).join("") || '<div class="empty">No projects yet. <a href="/app/?new=1">Start one</a> — it is saved under your login as you work.</div>'; }).catch(function(e){ var el = document.getElementById("hRecent"); if (el) el.innerHTML = '<div class="empty">' + esc(e.message) + "</div>"; });
    if (p.office || p.site) api("GET", "/api/live").then(function(j){ var el = document.getElementById("hLive"); if (!el) return;
      var act = j.projects.filter(function(x){ return x.state !== "done"; });
      el.innerHTML = act.slice(0, 6).map(liveRow).join("") || '<div class="empty">No project in progress.</div>'; }).catch(function(e){ var el = document.getElementById("hLive"); if (el) el.innerHTML = '<div class="empty">' + esc(e.message) + "</div>"; });
    api("GET", "/api/notifications").then(function(j){ var el = document.getElementById("hNote"); if (!el) return; el.innerHTML = noteRows(j.items.slice(0, 6)) || '<div class="empty">Nothing new.</div>'; bindNotes(el); });
  }
  function noteRows(items){
    return items.map(function(n){ return '<button type="button" class="row" data-nid="' + n.id + '" data-url="' + esc(n.url) + '"><span class="av' + (n.read ? " off" : "") + '" style="' + (n.read ? "" : "background:var(--red)") + '">' + SVG.bell.replace("<svg", '<svg width="16" height="16"') + '</span><div class="t"><b style="' + (n.read ? "font-weight:600" : "") + '">' + esc(n.title) + "</b><small>" + esc(n.body || "") + '</small></div><div class="r">' + esc(ago(n.at)) + "</div></button>"; }).join("");
  }
  function bindNotes(el){ el.querySelectorAll("[data-nid]").forEach(function(b){ b.onclick = function(){ api("POST", "/api/notifications/read", { ids:[+b.dataset.nid] }).catch(function(){}).then(function(){ E.goTo(b.dataset.url); }); }; }); }

  /* ---------- Projects ---------- */
  function projects(page, sub){
    var scope = sub || "", q = "";
    var tabs = [["", "All my projects"], ["mine", "Mine"], ["shared", "Shared with me"]];
    if (me.perms.allDesigns) tabs.push(["all", "Everyone’s"]);
    tabs.push(["trash", "Deleted"]);
    page.innerHTML = '<div class="hello"><div><h1>Projects</h1><p>Saved under your login while you work — open them on any device.</p></div><div class="acts"><a class="btn pri" href="/app/?new=1">' + SVG.plus + "New project</a></div></div>" +
      '<div class="tabs">' + tabs.map(function(t){ return '<a href="#projects' + (t[0] ? "/" + t[0] : "") + '" class="' + (t[0] === scope ? "on" : "") + '">' + t[1] + "</a>"; }).join("") + "</div>" +
      '<div class="toolbar"><input class="in" id="pq" placeholder="Search by customer name"></div><div class="card scroll-x" id="pl"><div class="empty">Loading…</div></div>';
    var list = [];
    function render(){
      var rows = list.filter(function(p){ return !q || p.name.toLowerCase().indexOf(q) >= 0 || p.owner.name.toLowerCase().indexOf(q) >= 0; });
      var el = document.getElementById("pl");
      if (!rows.length){ el.innerHTML = '<div class="empty">' + (q ? "No project matches." : scope === "trash" ? "Nothing deleted. Deleted projects stay here for 30 days." : scope === "shared" ? "Nothing is shared with you yet." : 'No projects yet — <a href="/app/?new=1">start one</a>.') + "</div>"; return; }
      el.innerHTML = '<table class="tbl"><thead><tr><th>Project</th><th>Owner</th><th>Shared with</th><th>Points</th><th>Last saved</th><th></th></tr></thead><tbody>' + rows.map(function(p){
        return '<tr class="click" data-id="' + p.id + '"><td><b>' + esc(p.name) + "</b>" + (p.siteId ? '<span class="pill green">live</span>' : "") + (p.access === "view" ? '<span class="pill">view only</span>' : "") + "</td>" +
          "<td>" + (p.owner.id === me.id ? '<span class="muted">You</span>' : esc(p.owner.name)) + "</td>" +
          '<td class="muted">' + (p.sharedWith.length ? esc(p.sharedWith.map(function(s){ return s.id === me.id ? "You" : s.name.split(" ")[0]; }).join(", ")) : "—") + "</td>" +
          "<td>" + p.points + ' <span class="muted">· ' + p.floors + " fl.</span></td>" +
          '<td class="muted">' + esc(ago(scope === "trash" ? p.deletedAt : p.updatedAt)) + (p.updatedBy.name && scope !== "trash" ? " · " + esc(p.updatedBy.name.split(" ")[0]) : "") + "</td>" +
          '<td style="text-align:right;white-space:nowrap">' + (scope === "trash" ? '<button type="button" class="btn sm" data-restore="' + p.id + '">Restore</button>' : '<button type="button" class="btn sm ghost" data-more="' + p.id + '" aria-label="More">' + SVG.dots + "</button>") + "</td></tr>";
      }).join("") + "</tbody></table>";
      el.querySelectorAll("tr[data-id]").forEach(function(tr){ tr.onclick = function(e){ if (e.target.closest("button")) return; if (scope !== "trash") location.href = "/app/?project=" + tr.dataset.id; }; });
      el.querySelectorAll("[data-more]").forEach(function(b){ b.onclick = function(){ more(b, list.find(function(p){ return p.id === b.dataset.more; })); }; });
      el.querySelectorAll("[data-restore]").forEach(function(b){ b.onclick = function(){ api("POST", "/api/dc/projects/" + b.dataset.restore + "/restore").then(function(){ toast("Restored"); load(); }).catch(function(e){ toast(e.message); }); }; });
    }
    function load(){ api("GET", "/api/dc/projects?scope=" + scope).then(function(j){ list = j.projects; render(); }).catch(function(e){ err(document.getElementById("pl"), e); }); }
    document.getElementById("pq").oninput = function(e){ q = e.target.value.trim().toLowerCase(); render(); };
    load();
    function more(anchor, p){
      E.popover(anchor, function(pop){
        var owner = p.owner.id === me.id || me.perms.admin, edit = p.access !== "view";
        var it = [["open", "Open in the planner"], ["share", "Share…"], ["versions", "Versions…"]];
        if (edit) it.push(["rename", "Rename…"]);
        it.push(["copy", "Make a copy"]);
        if (p.siteId && (me.perms.office || me.perms.site)) it.push(["site", "Open the live project"]);
        if (owner) it.push(["give", "Hand over to someone…"], ["delete", "Delete"]);
        else it.push(["leave", "Remove from my projects"]);
        pop.innerHTML = '<div class="etx-menu">' + it.map(function(x){ return '<button type="button" class="etx-mi" data-a="' + x[0] + '"' + (x[0] === "delete" ? ' style="color:var(--etx-red)"' : "") + ">" + x[1] + "</button>"; }).join("") + "</div>";
        pop.querySelectorAll("[data-a]").forEach(function(b){ b.onclick = function(){ E.closePopover(); act(b.dataset.a, p); }; });
      });
    }
    function act(a, p){
      if (a === "open") location.href = "/app/?project=" + p.id;
      else if (a === "share") E.shareDialog(p, function(){ load(); });
      else if (a === "versions") E.versionsDialog(p, function(){ load(); });
      else if (a === "site") location.href = "/app/site.html#p=" + p.siteId;
      else if (a === "copy") api("POST", "/api/dc/projects/" + p.id + "/copy", {}).then(function(){ toast("Copy made — it is in your projects"); load(); }).catch(function(e){ toast(e.message); });
      else if (a === "rename"){
        var m = modal({ title:"Rename", width:440, html:'<label>Customer / project name<input class="in" id="rn" value="' + esc(p.name) + '" autofocus></label>',
          buttons:[{ label:"Cancel" }, { label:"Rename", kind:"pri", onClick:function(close){ var n = document.getElementById("rn").value.trim(); if (!n) return;
            api("PATCH", "/api/dc/projects/" + p.id, { name:n }).then(function(){ close(); load(); }).catch(function(e){ toast(e.message); }); } }] });
      } else if (a === "give"){
        api("GET", "/api/users").then(function(j){
          var opts = j.users.filter(function(u){ return u.design && u.id !== p.owner.id; });
          modal({ title:"Hand over “" + p.name + "”", width:460, html:'<p class="muted" style="margin-top:0">The new owner gets the project; you keep it as shared with you (you can still edit).</p><label>New owner<select class="sel" id="to">' + opts.map(function(u){ return '<option value="' + u.id + '">' + esc(u.name) + "</option>"; }).join("") + "</select></label>",
            buttons:[{ label:"Cancel" }, { label:"Hand over", kind:"pri", onClick:function(close){ api("POST", "/api/dc/projects/" + p.id + "/transfer", { userId:document.getElementById("to").value }).then(function(){ close(); toast("Handed over"); load(); }).catch(function(e){ toast(e.message); }); } }] });
        });
      } else if (a === "delete"){
        modal({ title:"Delete “" + p.name + "”?", width:460, html:'<p style="margin-top:0">It moves to <b>Deleted</b> for 30 days, where you can restore it. The live project on site (if any) is not touched.</p>',
          buttons:[{ label:"Cancel" }, { label:"Delete", kind:"pri", onClick:function(close){ api("DELETE", "/api/dc/projects/" + p.id).then(function(){ close(); load(); }).catch(function(e){ toast(e.message); }); } }] });
      } else if (a === "leave"){
        api("DELETE", "/api/dc/projects/" + p.id + "/shares/" + me.id).then(function(){ toast("Removed from your projects"); load(); }).catch(function(e){ toast(e.message); });
      }
    }
  }

  /* ---------- Live projects ---------- */
  function live(page){
    page.innerHTML = '<div class="hello"><div><h1>Live projects</h1><p>Installations on site. Tap one to open it in the site app.</p></div><div class="acts">' +
      (me.perms.office ? '<a class="btn pri" href="/app/site.html#new">' + SVG.plus + "Project without drawing</a>" : "") + '<a class="btn" href="/app/site.html">' + SVG.phone + "Open the site app</a></div></div>" +
      (me.perms.office ? '<p class="muted small" style="margin:-8px 2px 14px">No plan (old villa, access points or cameras only)? Make the device list on site during the survey, or fill it from the approved Zoho quotation — the team then works from the list.</p>' : "") +
      "<div class=\"card list\" id=\"ll\"><div class=\"empty\">Loading…</div></div>";
    api("GET", "/api/live").then(function(j){
      var el = document.getElementById("ll");
      if (!j.projects.length){ el.innerHTML = '<div class="empty">No live projects yet. They start from the planner (Start, after the customer approves).</div>'; return; }
      var act = j.projects.filter(function(x){ return x.state !== "done"; }), done = j.projects.filter(function(x){ return x.state === "done"; });
      el.innerHTML = act.concat(done).map(function(p){
        return '<div class="row"><div class="t"><b>' + esc(p.name) + (p.state === "survey" ? '<span class="pill amber">site survey</span>' : "") + (p.list ? '<span class="pill">no drawing</span>' : "") + (p.paused ? '<span class="pill amber">paused</span>' : p.state === "done" ? '<span class="pill green">completed</span>' : "") + (p.openReports ? '<span class="pill red">' + p.openReports + " open report" + (p.openReports > 1 ? "s" : "") + "</span>" : "") + "</b><small>" +
          (p.nextStage ? "Next: " + esc(p.nextStage) + " · " : "") + p.points + " points · started " + esc(ago(p.startedAt)) + '</small></div><div class="bar' + (p.pct === 100 ? " ok" : "") + '"><i style="width:' + p.pct + '%"></i></div><div class="r" style="min-width:38px">' + p.pct + '%</div><div class="acts">' +
          (p.viewKey ? '<button type="button" class="btn sm" data-client="' + p.id + "-" + p.viewKey + '">Client link</button>' : "") +
          (me.perms.design && !p.list ? '<a class="btn sm" href="/app/?site=' + p.id + '">Planner</a>' : "") + '<a class="btn sm pri" href="/app/site.html#p=' + p.id + '">Open</a></div></div>';
      }).join("");
      el.querySelectorAll("[data-client]").forEach(function(b){ b.onclick = function(){ copy(location.origin + "/#" + b.dataset.client, "Client link copied — the customer sees progress and photos, view only"); }; });
    }).catch(function(e){ err(document.getElementById("ll"), e); });
  }

  /* ---------- Notifications ---------- */
  function notifications(page){
    page.innerHTML = '<div class="hello"><div><h1>Notifications</h1><p>Shares, site reports and changes to your projects. <a href="#account">Choose what reaches your phone</a>.</p></div><div class="acts"><button type="button" class="btn" id="allRead">Mark all read</button></div></div><div class="card list" id="nl"><div class="empty">Loading…</div></div><div style="text-align:center;margin-top:12px"><button type="button" class="btn hidden" id="older">Show older</button></div>';
    var items = [];
    function load(before){ api("GET", "/api/notifications" + (before ? "?before=" + before : "")).then(function(j){
      items = before ? items.concat(j.items) : j.items;
      var el = document.getElementById("nl"); el.innerHTML = noteRows(items) || '<div class="empty">Nothing yet.</div>'; bindNotes(el);
      document.getElementById("older").classList.toggle("hidden", j.items.length < 40);
    }); }
    document.getElementById("allRead").onclick = function(){ api("POST", "/api/notifications/read", { all:true }).then(function(){ E.unread = 0; load(); }); };
    document.getElementById("older").onclick = function(){ load(items[items.length - 1].id); };
    load();
  }

  /* ---------- My account ---------- */
  function account(page){
    page.innerHTML = '<div class="hello"><div><h1>My account</h1><p>' + esc(me.name) + " · username <b>" + esc(me.username) + "</b> · " + esc(E.describe(me.perms)) + "</p></div></div>" +
      '<div class="two"><section><h2 class="sec">Phone notifications</h2><div class="card" style="padding:16px" id="np"><div class="empty">Loading…</div></div></section>' +
      '<section><h2 class="sec">Password</h2><div class="card" style="padding:16px"><form id="pw"><label>Current password<input class="in" type="password" id="pc" autocomplete="current-password" required></label>' +
      '<label>New password (8 characters or more)<input class="in" type="password" id="pn" autocomplete="new-password" minlength="8" required></label><p class="err" id="pe"></p><button class="btn pri" type="submit">Change password</button>' +
      '<p class="muted small" style="margin:10px 0 0">Changing it signs you out on your other devices.</p></form></div>' +
      '<h2 class="sec">Contact</h2><div class="card" style="padding:16px"><div class="form-grid"><label>Email<input class="in" id="em" value="' + esc(me.email) + '"></label><label>Mobile<input class="in" id="ph" value="' + esc(me.phone) + '"></label></div><button type="button" class="btn" id="saveC">Save</button></div></section></div>';
    document.getElementById("pw").onsubmit = function(e){ e.preventDefault(); document.getElementById("pe").textContent = "";
      api("POST", "/api/me/password", { current:document.getElementById("pc").value, next:document.getElementById("pn").value }).then(function(){ toast("Password changed"); document.getElementById("pw").reset(); }).catch(function(x){ document.getElementById("pe").textContent = x.message; }); };
    document.getElementById("saveC").onclick = function(){ api("PATCH", "/api/me", { email:document.getElementById("em").value, phone:document.getElementById("ph").value }).then(function(){ toast("Saved"); me.email = document.getElementById("em").value; }).catch(function(x){ toast(x.message); }); };
    function renderPush(){
      api("GET", "/api/me/notifications").then(function(j){
        var el = document.getElementById("np"); if (!el) return;
        el.innerHTML = '<p class="muted" style="margin:0 0 10px">Everything always shows under the bell. These also reach your phone or computer as a notification once you turn it on for that device.</p>' +
          '<div class="toggles">' + j.kinds.map(function(k){ return '<label class="tog"><input type="checkbox" data-k="' + k.key + '"' + (j.prefs.push[k.key] ? " checked" : "") + "><span><b>" + esc(k.label) + "</b></span></label>"; }).join("") + "</div>" +
          '<div style="display:flex;gap:8px;flex-wrap:wrap"><button type="button" class="btn pri" id="pOn">Turn on for this device</button>' + (j.devices.length ? '<button type="button" class="btn" id="pTest">Send a test</button>' : "") + "</div>" +
          '<p class="muted small" style="margin:10px 0 0">' + (j.devices.length ? j.devices.length + " device" + (j.devices.length > 1 ? "s" : "") + " get notifications." : "No device yet.") + " On iPhone / iPad add the site app to the Home Screen first and turn it on from there.</p>";
        el.querySelectorAll("[data-k]").forEach(function(c){ c.onchange = function(){ var o = { push:{} }; o.push[c.dataset.k] = c.checked; api("PUT", "/api/me/notifications", o).catch(function(x){ toast(x.message); }); }; });
        document.getElementById("pOn").onclick = function(){ E.enablePush().then(function(){ toast("Notifications are on for this device"); renderPush(); }).catch(function(x){ toast(x.message, 6000); }); };
        var t = document.getElementById("pTest"); if (t) t.onclick = function(){ api("POST", "/api/push/test").then(function(r){ toast(r.delivered ? "Sent to " + r.delivered + " device" + (r.delivered > 1 ? "s" : "") : "Could not deliver: " + (r.errors[0] || "no device")); }); };
      }).catch(function(x){ err(document.getElementById("np"), x); });
    }
    renderPush();
  }

  /* ---------- Connect Claude ---------- */
  function claude(page){
    api("GET", "/api/me/claude").then(function(j){
      page.innerHTML = '<div class="hello"><div><h1>Connect Claude</h1><p>Your own Claude (desktop app, claude.ai, phone) can read your Design Center projects and live project progress — with your login and your permissions.</p></div></div>' +
        (!j.enabled ? '<div class="notice">Connecting Claude is switched off. ' + (me.perms.admin ? 'Switch it on in <a href="#admin/integrations">Admin → Integrations</a>.' : "Ask an admin to switch it on.") + "</div>" : "") +
        (!j.https ? '<div class="notice red">The Design Center is not on its public https address yet, so Claude can’t reach it.</div>' : "") +
        '<div class="two"><section><h2 class="sec">Add it to Claude</h2><div class="card" style="padding:18px"><ol class="steps" style="color:var(--text)">' +
        "<li>In Claude open <b>Settings → Connectors</b> and press <b>Add custom connector</b>.</li><li>Name: <b>Express Tech Design Center</b>. URL:</li></ol>" +
        '<div class="copyline" style="margin:0 0 14px"><input class="in" readonly value="' + esc(j.mcpUrl) + '"><button type="button" class="btn" id="cp">Copy</button></div>' +
        '<ol class="steps" start="3" style="color:var(--text)"><li>Press <b>Connect</b>, sign in here with <b>your</b> username and password, and press <b>Allow</b>.</li><li>Ask Claude e.g. “What’s left on Al Bisher villa?” or “Make a Zoho quote from the Villa 387 design”.</li></ol>' +
        '<p class="muted small" style="margin:0">Each person connects their own Claude. It sees only what you can see.</p></div></section>' +
        '<section><h2 class="sec">Connected</h2><div class="card list" id="cl">' + (j.connections.length ? j.connections.map(function(c){ return '<div class="row"><span class="av" style="background:#c96442">AI</span><div class="t"><b>' + esc(c.name) + "</b><small>Connected " + esc(ago(c.since)) + " · last used " + esc(ago(c.lastUsed)) + '</small></div><button type="button" class="btn sm danger" data-off="' + c.id + '">Disconnect</button></div>'; }).join("") : '<div class="empty">Not connected yet.</div>') + "</div></section></div>";
      document.getElementById("cp").onclick = function(){ copy(j.mcpUrl, "Address copied"); };
      page.querySelectorAll("[data-off]").forEach(function(b){ b.onclick = function(){ api("DELETE", "/api/me/claude/" + b.dataset.off).then(function(){ route(); }); }; });
    }).catch(function(e){ err(page, e); });
  }

  /* ---------- Admin ---------- */
  function admin(page, sub){
    if (!me.perms.admin){ page.innerHTML = '<div class="notice red">Only admins can open this page.</div>'; return; }
    sub = sub || "users";
    page.innerHTML = '<div class="hello"><div><h1>Admin</h1><p>Logins &amp; permissions, integrations and the server.</p></div></div>' +
      '<div class="tabs">' + [["users", "Logins & permissions"], ["integrations", "Integrations"], ["system", "System"], ["activity", "Admin activity"]].map(function(t){ return '<a href="#admin/' + t[0] + '" class="' + (t[0] === sub ? "on" : "") + '">' + esc(t[1]) + "</a>"; }).join("") + "</div><div id=\"ad\"></div>";
    var el = document.getElementById("ad");
    ({ users:adminUsers, integrations:adminInteg, system:adminSystem, activity:adminActivity }[sub] || adminUsers)(el);
  }

  // ---- Logins & permissions
  var A = null;
  function adminUsers(el){
    el.innerHTML = '<div class="empty">Loading…</div>';
    api("GET", "/api/admin/users").then(function(j){
      A = j;
      el.innerHTML = '<div class="toolbar"><input class="in" id="uq" placeholder="Search people"><span style="flex:1"></span><button type="button" class="btn pri" id="addU">' + SVG.plus + "Add login</button></div>" +
        '<div class="card scroll-x"><table class="tbl"><thead><tr><th>Person</th><th>Access</th><th>Site app</th><th>Last sign-in</th><th></th></tr></thead><tbody id="ut"></tbody></table></div>' +
        '<p class="muted small" style="margin:12px 2px">Each person signs in with their own username and password — the same login for the site app and, if allowed, the Design Center. New logins get a temporary password and choose their own at the first sign-in.</p>';
      var q = "";
      function render(){
        document.getElementById("ut").innerHTML = j.users.filter(function(u){ return !q || (u.name + " " + u.username).toLowerCase().indexOf(q) >= 0; }).map(function(u){
          var p = u.perms, chips = [];
          if (p.admin) chips.push('<span class="pill dark">Admin</span>');
          if (p.design) chips.push('<span class="pill red">Design Center</span>');
          if (p.allDesigns && !p.admin) chips.push('<span class="pill">All designs</span>');
          if (p.office && !p.admin) chips.push('<span class="pill amber">Live projects office</span>');
          if (!chips.length && !p.site) chips.push('<span class="pill">No access</span>');
          return '<tr class="click" data-u="' + u.id + '"' + (u.active ? "" : ' style="opacity:.55"') + '><td><div class="who"><span class="av' + (u.active ? "" : " off") + '">' + esc(E.initials(u.name)) + "</span><div><b>" + esc(u.name) + "</b><small>" + esc(u.username) + (u.active ? "" : " · switched off") + (u.mustChangePassword && u.active ? " · hasn’t chosen a password yet" : "") + "</small></div></div></td>" +
            '<td><div class="chips">' + chips.join("") + "</div></td><td>" + (p.site ? '<span class="pill green">' + esc(cfg.siteRoles[p.site]) + "</span>" : '<span class="muted">—</span>') + "</td>" +
            '<td class="muted">' + (u.lastLoginAt ? esc(ago(u.lastLoginAt)) : "never") + '</td><td style="text-align:right"><button type="button" class="btn sm">Edit</button></td></tr>';
        }).join("");
        document.querySelectorAll("#ut [data-u]").forEach(function(tr){ tr.onclick = function(){ userDialog(j.users.find(function(u){ return u.id === tr.dataset.u; })); }; });
      }
      render();
      document.getElementById("uq").oninput = function(e){ q = e.target.value.trim().toLowerCase(); render(); };
      document.getElementById("addU").onclick = function(){ userDialog(null); };
    }).catch(function(e){ err(el, e); });
  }
  function userDialog(u){
    var isNew = !u, p = u ? Object.assign({}, u.perms) : { design:false, allDesigns:false, office:false, admin:false, site:"" };
    var flagRows = A.flags.map(function(f){ return '<label class="tog" data-flag="' + f.key + '"><input type="checkbox" data-f="' + f.key + '"><span><b>' + esc(f.label) + "</b><small>" + esc(f.help) + "</small></span></label>"; }).join("");
    var staffOpts = '<option value="">' + (u && u.staff ? "Keep: " + esc(u.staff.name) + " (" + esc(cfg.siteRoles[u.staff.role] || u.staff.role) + ")" : "New person in the site app") + "</option>" +
      A.unlinkedStaff.filter(function(s){ return s.active; }).map(function(s){ return '<option value="' + s.id + '">' + esc(s.name) + " — from the old links (keeps their projects, ticks and history)</option>"; }).join("");
    var m = modal({ title:isNew ? "Add login" : u.name, width:640, html:
      '<div class="form-grid"><label>Full name<input class="in" id="fn" value="' + esc(u ? u.name : "") + '" placeholder="e.g. Kutbuddin Hussain" autofocus></label>' +
      '<label>Username (to sign in)<input class="in" id="fu" value="' + esc(u ? u.username : "") + '" placeholder="e.g. kutub" autocapitalize="none" spellcheck="false"></label>' +
      '<label>Email (optional)<input class="in" id="fe" value="' + esc(u ? u.email : "") + '"></label><label>Mobile (optional)<input class="in" id="fp" value="' + esc(u ? u.phone : "") + '"></label></div>' +
      '<label style="margin-bottom:6px">Quick choice</label><div class="presets">' + A.presets.map(function(x){ return '<button type="button" data-pre="' + x.id + '">' + esc(x.label) + "</button>"; }).join("") + "</div>" +
      '<div class="toggles">' + flagRows + '<label class="tog"><span style="flex:1"><b>Site app role</b><small>What they do on site: technicians install and align, the site engineer configures, managers see every live project.</small></span><select class="sel" id="fs">' +
      A.siteRoles.map(function(r){ return '<option value="' + r.id + '">' + esc(r.label) + "</option>"; }).join("") + "</select></label>" +
      '<label class="tog" id="stRow"><span style="flex:1"><b>Site app person</b><small>Pick their name if they already used a personal site app link, so their projects and history carry on.</small></span><select class="sel" id="fst" style="max-width:280px">' + staffOpts + "</select></label></div>",
      buttons:(isNew ? [] : [{ label:"Reset password", onClick:function(){ resetPw(u); } }, { label:u.active ? "Switch off login" : "Switch on login", kind:"danger", onClick:function(close){ save(close, { active:!u.active }); } }])
        .concat([{ label:"Cancel" }, { label:isNew ? "Add login" : "Save", kind:"pri", onClick:function(close){ save(close); } }]) });
    var B = m.body;
    function paint(){
      B.querySelectorAll("[data-f]").forEach(function(c){ var k = c.dataset.f; c.checked = !!p[k]; var forced = p.admin && k !== "admin"; c.disabled = forced; c.closest(".tog").classList.toggle("dis", forced); });
      B.querySelector("#fs").value = p.site || "";
      B.querySelector("#stRow").style.display = p.site || p.office || p.admin ? "" : "none";
      B.querySelectorAll("[data-pre]").forEach(function(b){ var x = A.presets.find(function(y){ return y.id === b.dataset.pre; }).perms;
        b.classList.toggle("on", ["admin", "design", "office", "allDesigns"].every(function(k){ return !!x[k] === !!p[k]; }) && (x.site || "") === (p.site || "")); });
    }
    B.querySelectorAll("[data-f]").forEach(function(c){ c.onchange = function(){ p[c.dataset.f] = c.checked; if (c.dataset.f === "admin" && c.checked){ p.design = p.allDesigns = p.office = true; if (!p.site) p.site = "manager"; } paint(); }; });
    B.querySelector("#fs").onchange = function(e){ p.site = e.target.value; paint(); };
    B.querySelectorAll("[data-pre]").forEach(function(b){ b.onclick = function(){ p = Object.assign({ design:false, allDesigns:false, office:false, admin:false, site:"" }, A.presets.find(function(x){ return x.id === b.dataset.pre; }).perms); paint(); }; });
    var fn = B.querySelector("#fn"), fu = B.querySelector("#fu"), touched = !isNew;
    fu.oninput = function(){ touched = true; };
    fn.oninput = function(){ if (!touched) fu.value = (fn.value.trim().split(/\s+/)[0] || "").toLowerCase().replace(/[^a-z0-9._-]/g, ""); };
    paint();
    function save(close, extra){
      var body = Object.assign({ name:fn.value.trim(), username:fu.value.trim(), email:B.querySelector("#fe").value.trim(), phone:B.querySelector("#fp").value.trim(), perms:p }, extra || {});
      var st = B.querySelector("#fst").value; if (st) body.staffId = st;
      (isNew ? api("POST", "/api/admin/users", body) : api("PATCH", "/api/admin/users/" + u.id, body)).then(function(r){
        close();
        if (isNew) showPassword(r.user, r.password, true);
        else toast(extra && extra.active === false ? r.user.name + " is switched off and signed out everywhere" : "Saved");
        adminUsers(document.getElementById("ad"));
      }).catch(function(e){ toast(e.message, 5000); });
    }
  }
  function resetPw(u){
    modal({ title:"Reset " + u.name + "’s password?", width:460, html:'<p style="margin-top:0">They get a new temporary password, are signed out everywhere, and choose their own at the next sign-in.</p>',
      buttons:[{ label:"Cancel" }, { label:"Reset password", kind:"pri", onClick:function(close){ api("POST", "/api/admin/users/" + u.id + "/reset-password").then(function(r){ close(); showPassword(u, r.password, false); }).catch(function(e){ toast(e.message); }); } }] });
  }
  function showPassword(u, pw, isNew){
    var link = location.origin + "/login";
    var msg = "Hi " + u.name.split(" ")[0] + ", your Express Tech login" + (isNew ? "" : " (new password)") + ":\n" + link + "\nUsername: " + u.username + "\nTemporary password: " + pw + "\nYou choose your own password when you sign in.";
    modal({ title:isNew ? "Login ready for " + u.name : "New password for " + u.name, width:480, html:
      '<p style="margin-top:0">Give these to ' + esc(u.name.split(" ")[0]) + '. The password is shown only now.</p><dl class="kv" style="margin-bottom:12px"><dt>Address</dt><dd>' + esc(link) + "</dd><dt>Username</dt><dd><b>" + esc(u.username) + "</b></dd></dl>" +
      '<div class="secret"><span>' + esc(pw) + "</span></div>",
      buttons:[{ label:"Copy message", onClick:function(){ copy(msg, "Message copied"); } }, { label:"WhatsApp", onClick:function(){ window.open("https://wa.me/" + (u.phone ? String(u.phone).replace(/\D/g, "") : "") + "?text=" + encodeURIComponent(msg), "_blank"); } }, { label:"Done", kind:"pri" }] });
  }

  // ---- Integrations
  function adminInteg(el){
    el.innerHTML = '<div class="empty">Loading…</div>';
    var qe = hq("error"), qc = hq("connected");
    api("GET", "/api/admin/integrations").then(function(j){
      var st = { connected:['green', "Connected"], off:["", "Off"], not_set_up:["", "Not set up"], error:["red", "Problem"] };
      el.innerHTML = (qe ? '<div class="notice red">' + esc(qe) + "</div>" : "") + (qc ? '<div class="notice green">Connected.</div>' : "") +
        '<div class="grid">' + j.integrations.map(function(i){ var s = st[i.status] || ["", i.status];
          return '<div class="card integ"><div class="h"><span class="logo" style="background:' + i.color + '">' + esc(i.initials) + "</span><div><b>" + esc(i.name) + "</b><small>" + esc(i.category) + '</small></div><span class="pill ' + s[0] + '">' + s[1] + "</span></div>" +
            "<p>" + esc(i.description) + "</p>" + (i.lastError && i.status === "error" ? '<p style="color:var(--red)">' + esc(i.lastError) + "</p>" : "") +
            '<div class="foot"><button type="button" class="btn" data-i="' + i.id + '">' + (i.configured ? "Settings" : "Set up") + "</button>" + (i.configured ? '<button type="button" class="btn ghost" data-t="' + i.id + '">Test</button>' : "") + "</div></div>"; }).join("") + "</div>";
      el.querySelectorAll("[data-i]").forEach(function(b){ b.onclick = function(){ integDialog(j.integrations.find(function(x){ return x.id === b.dataset.i; })); }; });
      el.querySelectorAll("[data-t]").forEach(function(b){ b.onclick = function(){ b.disabled = true; api("POST", "/api/admin/integrations/" + b.dataset.t + "/test").then(function(r){ toast(r.message, 6000); }).catch(function(e){ toast(e.message, 6000); }).finally(function(){ adminInteg(el); }); }; });
    }).catch(function(e){ err(el, e); });
  }
  function integDialog(i){
    var fields = i.fields.map(function(f){
      var v = i.values[f.key], help = f.help ? '<small class="muted" style="display:block;font-weight:400;margin-top:4px">' + esc(f.help) + "</small>" : "";
      if (f.type === "checkbox") return '<label class="tog" style="border:1px solid var(--line);border-radius:10px;margin-bottom:12px"><input type="checkbox" data-k="' + f.key + '"' + (v ? " checked" : "") + "><span><b>" + esc(f.label) + "</b></span></label>";
      if (f.type === "select") return "<label>" + esc(f.label) + '<select class="sel" data-k="' + f.key + '"' + (f.optionsAction ? ' data-act="' + f.optionsAction + '"' : "") + ">" +
        (f.options ? f.options.map(function(o){ return '<option value="' + esc(o[0]) + '"' + (o[0] === v ? " selected" : "") + ">" + esc(o[1]) + "</option>"; }).join("") : '<option value="' + esc(v || "") + '">' + esc(v || "—") + "</option>") + "</select>" + help + "</label>";
      if (f.type === "secret") return "<label>" + esc(f.label) + '<input class="in" type="password" autocomplete="off" data-k="' + f.key + '" placeholder="' + (i.secretsSet[f.key] ? "•••••••• saved — leave empty to keep" : "Paste it here") + '">' + help + "</label>";
      return "<label>" + esc(f.label) + '<input class="in" data-k="' + f.key + '" value="' + esc(v || "") + '" placeholder="' + esc(f.placeholder || "") + '">' + help + "</label>";
    }).join("");
    var info = "";
    if (i.info && i.info.redirectUri) info += '<label>Authorized Redirect URI (for the Zoho API Console)<div class="copyline" style="margin-top:5px"><input class="in" readonly value="' + esc(i.info.redirectUri) + '"><button type="button" class="btn" data-copy="' + esc(i.info.redirectUri) + '">Copy</button></div></label>';
    if (i.info && i.info.mcpUrl) info += '<label>Connector address<div class="copyline" style="margin-top:5px"><input class="in" readonly value="' + esc(i.info.mcpUrl) + '"><button type="button" class="btn" data-copy="' + esc(i.info.mcpUrl) + '">Copy</button></div></label><p class="muted small">' + i.info.connectedPeople + " connected · each person adds it from <a href=\"#claude\">Connect Claude</a>.</p>";
    if (i.info && i.info.linkedProjects !== undefined) info += '<p class="muted small">' + i.info.linkedProjects + " live project" + (i.info.linkedProjects === 1 ? "" : "s") + " linked to Asana · mirrored every " + Math.round(i.info.everySeconds / 60) + " minutes.</p>";
    var m = modal({ title:i.name, width:620, html:'<p class="muted" style="margin-top:0">' + esc(i.description) + "</p>" + (i.setup.length ? '<ol class="steps">' + i.setup.map(function(s){ return "<li>" + esc(s) + "</li>"; }).join("") + "</ol>" : "") +
      fields + info + (i.log.length ? '<label>Recent activity</label><div class="log">' + i.log.map(function(l){ return esc(l.at.slice(0, 16).replace("T", " ") + "  " + l.message); }).join("\n") + "</div>" : ""),
      buttons:[{ label:"Disconnect", kind:"danger", onClick:function(close){ if (!confirm("Disconnect " + i.name + "? Its saved settings are removed.")) return; api("DELETE", "/api/admin/integrations/" + i.id).then(function(){ close(); adminInteg(document.getElementById("ad")); }); } }]
        .concat(i.oauth ? [{ label:"Connect with Zoho", onClick:function(){ saveIt().then(function(){ return api("POST", "/api/admin/integrations/" + i.id + "/authorize"); }).then(function(r){ location.href = r.url; }).catch(function(e){ toast(e.message, 6000); }); } }] : [])
        .concat([{ label:i.enabled ? "Switch off" : "Switch on", onClick:function(close){ saveIt({ enabled:!i.enabled }).then(function(){ close(); adminInteg(document.getElementById("ad")); }).catch(function(e){ toast(e.message, 6000); }); } },
                 { label:"Save", kind:"pri", onClick:function(close){ saveIt().then(function(){ close(); toast("Saved"); adminInteg(document.getElementById("ad")); }).catch(function(e){ toast(e.message, 6000); }); } }]) });
    m.body.querySelectorAll("[data-copy]").forEach(function(b){ b.onclick = function(){ copy(b.dataset.copy); }; });
    m.body.querySelectorAll("[data-act]").forEach(function(s){
      api("POST", "/api/admin/integrations/" + i.id + "/actions/" + s.dataset.act).then(function(r){ var v = s.value;
        s.innerHTML = r.result.map(function(o){ return '<option value="' + esc(o.value) + '"' + (o.value === v ? " selected" : "") + ">" + esc(o.label) + "</option>"; }).join(""); if (v) s.value = v; }).catch(function(){});
    });
    function saveIt(extra){
      var c = {};
      m.body.querySelectorAll("[data-k]").forEach(function(x){ var f = i.fields.find(function(y){ return y.key === x.dataset.k; }); if (!f) return;
        if (f.type === "checkbox") c[f.key] = x.checked; else if (f.type === "secret"){ if (x.value.trim()) c[f.key] = x.value.trim(); } else c[f.key] = x.value; });
      return api("PUT", "/api/admin/integrations/" + i.id, Object.assign({ config:c }, extra || {}));
    }
  }

  // ---- System
  function fmtBytes(n){ return n > 1073741824 ? (n / 1073741824).toFixed(1) + " GB" : n > 1048576 ? (n / 1048576).toFixed(1) + " MB" : Math.round(n / 1024) + " KB"; }
  function adminSystem(el){
    el.innerHTML = '<div class="empty">Loading…</div>';
    api("GET", "/api/admin/system").then(function(s){
      var c = s.counts;
      el.innerHTML = '<div class="two"><section><h2 class="sec">Server</h2><div class="card" style="padding:16px"><dl class="kv">' +
        "<dt>Address</dt><dd>" + esc(s.appUrl) + "</dd><dt>Version</dt><dd>" + esc(s.version) + (s.planner ? " · planner " + esc(s.planner.planner) + " · site app " + esc(s.planner.site) : "") + "</dd>" +
        "<dt>Running since</dt><dd>" + esc(new Date(s.startedAt).toLocaleString()) + "</dd><dt>Server time</dt><dd>" + esc(s.serverTime) + "</dd><dt>Node</dt><dd>" + esc(s.node) + "</dd>" +
        "<dt>Open pages right now</dt><dd>" + s.liveConnections + "</dd><dt>Database</dt><dd>" + fmtBytes(s.dbSize) + "</dd><dt>Floor drawings</dt><dd>" + s.drawings.count + " · " + fmtBytes(s.drawings.bytes) + "</dd>" +
        "<dt>Logins</dt><dd>" + c.logins + "</dd><dt>Design Center projects</dt><dd>" + c.designProjects + "</dd><dt>Live projects</dt><dd>" + c.liveProjects + " · " + c.points + " points · " + c.photos + " photos</dd>" +
        "<dt>Phones with notifications</dt><dd>" + c.pushDevices + "</dd></dl></div>" +
        '<h2 class="sec">Backups <button type="button" class="btn sm" id="bk">Back up now</button></h2><div class="card list">' + (s.backups.length ? s.backups.map(function(b){ return '<div class="row"><div class="t"><b>' + esc(b.name) + "</b><small>" + fmtBytes(b.size) + "</small></div></div>"; }).join("") : '<div class="empty">No backup yet — one is made every night.</div>') + "</div>" +
        '<p class="muted small">Every night the database is copied to <b>data/backups</b> on the server. Copy the whole <b>data</b> folder off the server regularly (see INSTALL.md).</p></section>' +
        '<section><h2 class="sec">Move from Cloudflare</h2><div class="card" style="padding:16px" id="imp"></div></section></div>';
      document.getElementById("bk").onclick = function(){ api("POST", "/api/admin/backup").then(function(r){ toast("Saved " + r.file); adminSystem(el); }).catch(function(e){ toast(e.message); }); };
      renderImport(s.import);
    }).catch(function(e){ err(el, e); });
  }
  function renderImport(st){
    var box = document.getElementById("imp"); if (!box) return;
    var running = st.running;
    box.innerHTML = '<p style="margin-top:0">Copies every live project from the old ExpressTech server on Cloudflare: drawings, points, ticks, MAC addresses, photos, notes, site reports, activity, cabinet checklists, the people and the client links — plus the planner files saved there (as your Design Center projects). Safe to run again: it brings the latest over.</p>' +
      (st.last.at ? '<div class="notice green">Last copied ' + esc(ago(st.last.at)) + " from " + esc(st.last.from) + ".</div>" : "") +
      '<label>Old server address<input class="in" id="iu" value="https://expresstech.hussaink-060.workers.dev"' + (running ? " disabled" : "") + "></label>" +
      '<label>Office key of the old server<input class="in" id="ik" type="password" autocomplete="off" placeholder="Type or paste the office key"' + (running ? " disabled" : "") + "></label>" +
      '<label class="tog" style="border:1px solid var(--line);border-radius:10px;margin-bottom:12px"><input type="checkbox" id="if"' + (running ? " disabled" : "") + '><span><b>Start clean</b><small>Remove the live projects on this server first (only for a fresh start).</small></span></label>' +
      '<button type="button" class="btn pri" id="ig"' + (running ? " disabled" : "") + ">" + (running ? "Copying…" : "Copy everything") + "</button>" +
      (st.log.length ? '<div class="log" style="margin-top:12px">' + esc(st.log.join("\n")) + "</div>" : "") + (st.error ? '<div class="notice red" style="margin-top:12px">' + esc(st.error) + "</div>" : "");
    document.getElementById("ig").onclick = function(){
      var k = document.getElementById("ik").value.trim(); if (!k){ document.getElementById("ik").focus(); return; }
      api("POST", "/api/admin/import", { url:document.getElementById("iu").value.trim(), key:k, fresh:document.getElementById("if").checked }).then(function(r){ renderImport(r); poll(); }).catch(function(e){ toast(e.message, 6000); });
    };
    if (running) poll();
  }
  var pollT = null;
  function poll(){ clearTimeout(pollT); pollT = setTimeout(function(){ if (!document.getElementById("imp")) return; api("GET", "/api/admin/import").then(function(st){ renderImport(st); }); }, 1500); }

  // ---- Admin activity
  function adminActivity(el){
    api("GET", "/api/admin/audit").then(function(j){
      el.innerHTML = '<div class="card list">' + (j.items.length ? j.items.map(function(a){ return '<div class="row"><div class="t"><b>' + esc(a.by_name) + " · " + esc(a.action.replace(/-/g, " ")) + "</b><small>" + esc(a.detail) + '</small></div><div class="r">' + esc(ago(a.at)) + "</div></div>"; }).join("") : '<div class="empty">Nothing yet.</div>') + "</div>";
    }).catch(function(e){ err(el, e); });
  }
})();
