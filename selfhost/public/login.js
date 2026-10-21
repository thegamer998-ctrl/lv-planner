(function(){
  "use strict";
  var $ = function(id){ return document.getElementById(id); };
  var q = new URLSearchParams(location.search), next = q.get("next") || "/";
  if (!/^\/(?!\/)/.test(next)) next = "/";
  var current = "";
  function post(url, body){
    return fetch(url, { method:"POST", headers:{ "Content-Type":"application/json", "X-Express":"1" }, body:JSON.stringify(body), credentials:"same-origin" })
      .then(function(r){ return r.json().catch(function(){ return {}; }).then(function(j){ if (!r.ok) throw new Error(j.error || "Error " + r.status); return j; }); });
  }
  function showChange(){ $("signIn").hidden = true; $("change").hidden = false; $("n1").focus(); }
  // already signed in? (e.g. a password change is still due)
  fetch("/api/me", { credentials:"same-origin", cache:"no-store" }).then(function(r){ return r.ok ? r.json() : null; }).then(function(j){
    if (!j) return;
    if (j.user.mustChangePassword){ if (q.get("current")) current = q.get("current"); showChange(); }
    else location.replace(next);
  }).catch(function(){});
  $("signIn").addEventListener("submit", function(e){
    e.preventDefault(); $("err").textContent = ""; $("go").disabled = true;
    current = $("p").value;
    post("/api/auth/login", { username:$("u").value.trim(), password:current }).then(function(j){
      if (j.mustChangePassword) showChange(); else location.replace(next);
    }).catch(function(e){ $("err").textContent = e.message; }).finally(function(){ $("go").disabled = false; });
  });
  $("change").addEventListener("submit", function(e){
    e.preventDefault(); $("err2").textContent = "";
    if ($("n1").value !== $("n2").value){ $("err2").textContent = "The two passwords are not the same."; return; }
    if (!current){ $("err2").textContent = "Sign in again with the password you were given, then choose your own."; $("change").hidden = true; $("signIn").hidden = false; return; }
    post("/api/me/password", { current:current, next:$("n1").value }).then(function(){ location.replace(next); }).catch(function(e){ $("err2").textContent = e.message; });
  });
})();
