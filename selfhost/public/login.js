(function(){
  "use strict";
  var $ = function(id){ return document.getElementById(id); };
  var q = new URLSearchParams(location.search);
  // Only ever return to a page of this site (never another address, never //host or /\host).
  var next = (function(){
    var n = q.get("next") || "/";
    if (n !== "/" && !/^\/[^\/\\]/.test(n)) return "/";
    try { var u = new URL(n, location.origin); return u.origin === location.origin ? u.pathname + u.search + u.hash : "/"; } catch (e) { return "/"; }
  })();
  var current = "";
  function post(url, body){
    return fetch(url, { method:"POST", headers:{ "Content-Type":"application/json", "X-Express":"1" }, body:JSON.stringify(body || {}), credentials:"same-origin" })
      .then(function(r){ return r.json().catch(function(){ return {}; }).then(function(j){ if (!r.ok){ var e = new Error(j.error || "Error " + r.status); e.data = j; throw e; } return j; }); });
  }
  function only(id){ ["signIn","change","twofa"].forEach(function(f){ $(f).hidden = f !== id; }); }
  function showChange(){ only("change"); $("n1").focus(); }
  function showTwofa(){
    only("twofa"); $("err3").textContent = "";
    post("/api/me/2fa/setup").then(function(j){ $("qr").src = j.qr; $("key").textContent = j.secret; $("code2").focus(); })
      .catch(function(e){ $("err3").textContent = e.message; });
  }
  function after(j){ if (j.mustChangePassword) showChange(); else if (j.mustSetup2fa) showTwofa(); else location.replace(next); }
  // already signed in? (e.g. a new password or two-step sign-in is still due)
  fetch("/api/me", { credentials:"same-origin", cache:"no-store" }).then(function(r){ return r.ok ? r.json() : null; }).then(function(j){
    if (!j) return;
    if (j.user.mustChangePassword){ if (q.get("current")) current = q.get("current"); showChange(); }
    else if (j.user.mustSetup2fa) showTwofa();
    else location.replace(next);
  }).catch(function(){});
  $("signIn").addEventListener("submit", function(e){
    e.preventDefault(); $("err").textContent = ""; $("go").disabled = true;
    current = $("p").value;
    var cf = $("codeField"), code = cf.hidden ? "" : $("code").value.replace(/\s/g, "");
    post("/api/auth/login", { username:$("u").value.trim(), password:current, code:code }).then(after).catch(function(e){
      if (e.data && e.data.needCode && cf.hidden){ cf.hidden = false; $("code").focus(); return; }
      $("err").textContent = e.message; if (e.data && e.data.needCode){ $("code").value = ""; $("code").focus(); }
    }).finally(function(){ $("go").disabled = false; });
  });
  $("change").addEventListener("submit", function(e){
    e.preventDefault(); $("err2").textContent = "";
    if ($("n1").value !== $("n2").value){ $("err2").textContent = "The two passwords are not the same."; return; }
    if (!current){ $("err2").textContent = "Sign in again with the password you were given, then choose your own."; only("signIn"); return; }
    post("/api/me/password", { current:current, next:$("n1").value }).then(after).catch(function(e){ $("err2").textContent = e.message; });
  });
  $("twofa").addEventListener("submit", function(e){
    e.preventDefault(); $("err3").textContent = "";
    post("/api/me/2fa/enable", { code:$("code2").value.replace(/\s/g, "") }).then(function(){ location.replace(next); })
      .catch(function(e){ $("err3").textContent = e.message; $("code2").select(); });
  });
})();
