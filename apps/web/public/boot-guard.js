/*
 * The boot guard: what the page says when the app never gets to draw. It is a plain script, loaded before the app's
 * bundle and written in the JavaScript of old browsers (no modules, no arrow functions, no let or const), because
 * its job is the browsers the bundle cannot run in: an Android System WebView from years ago stops at the bundle's
 * syntax, a browser without an API the app starts with throws before React renders, and both left the page blank.
 *
 * It shows itself when an error arrives before the first render and the page is still empty a moment later, or when
 * the page has loaded and stays empty. It leaves as soon as the app (or its "open in another tab" screen) draws
 * into #root, so a slow start is never covered for long. "Copy details" holds the error, the browser's version and
 * which APIs are there: no address fragment, no storage, nothing of a chat or a key.
 *
 * A file of its own, not inline: the site's Content-Security-Policy allows scripts from this origin only.
 */
(function () {
  "use strict";

  /** How long after an error, and after the page's load, the app has to draw something. */
  var AFTER_ERROR_MS = 1500;
  var AFTER_LOAD_MS = 6000;
  /** The oldest engines the bundle is built for (Vite's "baseline widely available"). */
  var CHROME_FLOOR = 111;
  var IOS_FLOOR = [16, 4];

  var TEXT = {
    en: { title: "Ghostly could not start", slow: "Ghostly is taking long to start", why: "This browser may be too old, or it blocks something Ghostly needs.", "try": "Update your browser, or open Ghostly in another one.", android: "On Android, update Android System WebView and Chrome in Google Play.", ios: "On iPhone or iPad, update iOS.", reload: "Reload", copy: "Copy details", copied: "Copied" },
    pt: { title: "O Ghostly não conseguiu iniciar", slow: "O Ghostly está demorando para iniciar", why: "Este navegador pode ser antigo demais, ou bloqueia algo de que o Ghostly precisa.", "try": "Atualize o navegador, ou abra o Ghostly em outro.", android: "No Android, atualize o Android System WebView e o Chrome no Google Play.", ios: "No iPhone ou iPad, atualize o iOS.", reload: "Recarregar", copy: "Copiar detalhes", copied: "Copiado" },
    es: { title: "Ghostly no pudo iniciarse", slow: "Ghostly está tardando en iniciarse", why: "Este navegador puede ser demasiado antiguo, o bloquea algo que Ghostly necesita.", "try": "Actualiza el navegador, o abre Ghostly en otro.", android: "En Android, actualiza Android System WebView y Chrome en Google Play.", ios: "En iPhone o iPad, actualiza iOS.", reload: "Recargar", copy: "Copiar detalles", copied: "Copiado" },
    fr: { title: "Ghostly n'a pas pu démarrer", slow: "Ghostly met du temps à démarrer", why: "Ce navigateur est peut-être trop ancien, ou il bloque quelque chose dont Ghostly a besoin.", "try": "Mettez le navigateur à jour, ou ouvrez Ghostly dans un autre.", android: "Sur Android, mettez à jour Android System WebView et Chrome dans Google Play.", ios: "Sur iPhone ou iPad, mettez iOS à jour.", reload: "Recharger", copy: "Copier les détails", copied: "Copié" },
    it: { title: "Ghostly non è riuscito ad avviarsi", slow: "Ghostly ci sta mettendo molto ad avviarsi", why: "Questo browser potrebbe essere troppo vecchio, o blocca qualcosa che serve a Ghostly.", "try": "Aggiorna il browser, o apri Ghostly in un altro.", android: "Su Android, aggiorna Android System WebView e Chrome in Google Play.", ios: "Su iPhone o iPad, aggiorna iOS.", reload: "Ricarica", copy: "Copia dettagli", copied: "Copiato" },
    zh: { title: "Ghostly 无法启动", slow: "Ghostly 启动时间较长", why: "此浏览器可能版本过旧，或拦截了 Ghostly 需要的功能。", "try": "请更新浏览器，或在其他浏览器中打开 Ghostly。", android: "在 Android 上，请在 Google Play 中更新 Android System WebView 和 Chrome。", ios: "在 iPhone 或 iPad 上，请更新 iOS。", reload: "重新加载", copy: "复制详情", copied: "已复制" },
    ja: { title: "Ghostly を起動できませんでした", slow: "Ghostly の起動に時間がかかっています", why: "このブラウザは古すぎるか、Ghostly に必要な機能をブロックしている可能性があります。", "try": "ブラウザを更新するか、別のブラウザで Ghostly を開いてください。", android: "Android では、Google Play で Android System WebView と Chrome を更新してください。", ios: "iPhone または iPad では、iOS を更新してください。", reload: "再読み込み", copy: "詳細をコピー", copied: "コピーしました" },
    ar: { title: "تعذّر تشغيل Ghostly", slow: "Ghostly يستغرق وقتًا طويلًا للبدء", why: "قد يكون هذا المتصفح قديمًا جدًا، أو يحظر شيئًا يحتاجه Ghostly.", "try": "حدّث المتصفح، أو افتح Ghostly في متصفح آخر.", android: "على Android، حدّث Android System WebView و Chrome من Google Play.", ios: "على iPhone أو iPad، حدّث iOS.", reload: "إعادة التحميل", copy: "نسخ التفاصيل", copied: "تم النسخ" }
  };

  var started = Date.now();
  var errors = [];
  var reason = "";
  var panel = null;
  var done = false;
  var timers = [];
  var poll = null;
  var observer = null;

  function language() {
    var tag = "";
    try { tag = String(navigator.language || "").slice(0, 2).toLowerCase(); } catch (e) { /* English */ }
    return TEXT[tag] ? tag : "en";
  }

  /** Text that may come from anywhere (an error's message): no invite, no long key-like run, no address fragment. */
  function clean(text) {
    return String(text == null ? "" : text)
      .replace(/(https?:\/\/[^\s#?)]+)[#?][^\s)]*/g, "$1")
      .replace(/ghostly1[0-9a-z]+/gi, "[removed]")
      .replace(/[A-Za-z0-9_+\/=-]{40,}/g, "[removed]")
      .slice(0, 600);
  }

  function has(check) {
    try { return check() ? "yes" : "no"; } catch (e) { return "throws"; }
  }

  /** Which of the things the app starts with this browser has. Never reads what is stored. */
  function features() {
    var list = [
      ["secureContext", function () { return window.isSecureContext; }],
      ["locks", function () { return navigator.locks; }],
      ["indexedDB", function () { return window.indexedDB; }],
      ["localStorage", function () { return window.localStorage; }],
      ["cryptoSubtle", function () { return window.crypto && window.crypto.subtle; }],
      ["serviceWorker", function () { return navigator.serviceWorker; }],
      ["storagePersist", function () { return navigator.storage && navigator.storage.persist; }],
      ["opfs", function () { return navigator.storage && navigator.storage.getDirectory; }],
      ["broadcastChannel", function () { return window.BroadcastChannel; }],
      ["webAssembly", function () { return window.WebAssembly; }],
      ["webRTC", function () { return window.RTCPeerConnection; }],
      ["notification", function () { return window.Notification; }],
      ["push", function () { return window.PushManager; }],
      ["worker", function () { return window.Worker; }],
      ["hasOwn", function () { return Object.hasOwn; }]
    ];
    var out = [];
    for (var i = 0; i < list.length; i++) out.push(list[i][0] + "=" + has(list[i][1]));
    return out.join(" ");
  }

  function build() {
    try {
      var meta = document.querySelector('meta[name="ghostly-build"]');
      return meta ? meta.getAttribute("content") : "unknown";
    } catch (e) { return "unknown"; }
  }

  /** What "Copy details" holds. */
  function details() {
    var lines = ["Ghostly boot report", "reason: " + (reason || "none"), "build: " + build()];
    for (var i = 0; i < errors.length && i < 5; i++) lines.push("error: " + errors[i]);
    try { lines.push("page: " + location.origin + location.pathname); } catch (e) { /* no address */ }
    try { lines.push("browser: " + navigator.userAgent); } catch (e) { /* none */ }
    try { lines.push("language: " + navigator.language); } catch (e) { /* none */ }
    lines.push("features: " + features());
    lines.push("after: " + (Date.now() - started) + " ms");
    return lines.join("\n");
  }

  function painted() {
    var root = document.getElementById("root");
    return !!root && root.childElementCount > 0;
  }

  /** The update that most likely helps, from the browser's own description of itself. */
  function platformHint(text) {
    var agent = "";
    try { agent = navigator.userAgent || ""; } catch (e) { /* none */ }
    if (/Android/.test(agent)) {
      var chrome = /Chrome\/(\d+)/.exec(agent);
      if (/; wv\)/.test(agent) || !chrome || Number(chrome[1]) < CHROME_FLOOR) return text.android;
    }
    var ios = /(?:iPhone|iPad|iPod).*? OS (\d+)_(\d+)/.exec(agent);
    if (ios && (Number(ios[1]) < IOS_FLOOR[0] || (Number(ios[1]) === IOS_FLOOR[0] && Number(ios[2]) < IOS_FLOOR[1]))) return text.ios;
    return "";
  }

  function element(tag, style, text) {
    var node = document.createElement(tag);
    if (style) node.setAttribute("style", style);
    if (text) node.textContent = text;
    return node;
  }

  function show(why) {
    if (done || painted()) return;
    reason = reason === "error" ? reason : why;
    if (panel) return;
    if (!document.body) return;
    var tag = language();
    var text = TEXT[tag];
    panel = element("div", "position:fixed;top:0;right:0;bottom:0;left:0;z-index:2147483647;overflow:auto;display:flex;align-items:center;justify-content:center;padding:24px;box-sizing:border-box;background:#0b141a;color:#e9edef;font:15px/1.45 system-ui,-apple-system,'Segoe UI',Roboto,sans-serif;text-align:center");
    panel.id = "boot-fallback";
    panel.setAttribute("role", "alert");
    panel.setAttribute("data-testid", "boot-fallback");
    panel.setAttribute("data-reason", reason);
    panel.setAttribute("lang", tag);
    panel.setAttribute("dir", tag === "ar" ? "rtl" : "ltr");
    var box = element("div", "max-width:420px;width:100%");
    box.appendChild(element("div", "font-size:48px", "👻"));
    box.appendChild(element("h1", "font-size:18px;font-weight:600;margin:12px 0 8px", reason === "error" ? text.title : text.slow));
    box.appendChild(element("p", "margin:0 0 8px;color:#aebac1", text.why));
    box.appendChild(element("p", "margin:0 0 8px", text["try"]));
    var hint = platformHint(text);
    if (hint) {
      var hintLine = element("p", "margin:0 0 8px", hint);
      hintLine.setAttribute("data-testid", "boot-fallback-hint");
      box.appendChild(hintLine);
    }
    var button = "margin:12px 6px 0;padding:9px 16px;border-radius:8px;border:1px solid #3b4a54;background:#202c33;color:#e9edef;font:inherit;font-weight:600;cursor:pointer";
    var reload = element("button", button, text.reload);
    reload.type = "button";
    reload.onclick = function () { location.reload(); };
    var copy = element("button", button, text.copy);
    copy.type = "button";
    copy.setAttribute("data-testid", "boot-fallback-copy");
    var area = element("textarea", "display:block;width:100%;box-sizing:border-box;margin-top:16px;padding:8px;border-radius:8px;border:1px solid #3b4a54;background:#111b21;color:#aebac1;font:11px/1.4 ui-monospace,Menlo,Consolas,monospace;text-align:left;direction:ltr;resize:vertical");
    area.readOnly = true;
    area.rows = 7;
    area.setAttribute("data-testid", "boot-fallback-details");
    area.setAttribute("aria-label", text.copy);
    area.value = details();
    copy.onclick = function () {
      var said = function () { copy.textContent = text.copied; };
      // The field stays selected either way, so a browser that refuses both can still copy it by hand.
      var byHand = function () { try { area.focus(); area.select(); if (document.execCommand("copy")) said(); } catch (e) { /* selected for a manual copy */ } };
      try {
        if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(area.value).then(said, byHand);
        else byHand();
      } catch (e) { byHand(); }
    };
    box.appendChild(reload);
    box.appendChild(copy);
    box.appendChild(area);
    panel.appendChild(box);
    document.body.appendChild(panel);
  }

  function later(fn, ms) { timers.push(setTimeout(fn, ms)); }

  /** The app drew: the guard is over, for good. Errors from here on are the app's own error screen's. */
  function finish() {
    if (done) return;
    done = true;
    for (var i = 0; i < timers.length; i++) clearTimeout(timers[i]);
    if (poll !== null) clearInterval(poll);
    poll = null;
    if (observer) observer.disconnect();
    window.removeEventListener("error", onError, true);
    window.removeEventListener("unhandledrejection", onRejection);
    if (panel && panel.parentNode) panel.parentNode.removeChild(panel);
    panel = null;
  }

  function check() { if (painted()) finish(); }

  function failed(message) {
    if (done) return;
    if (painted()) { finish(); return; }
    errors.push(clean(message));
    if (panel) {
      // Already on screen (a slow start that then failed): the details follow.
      var area = panel.querySelector("textarea");
      if (area) area.value = details();
      return;
    }
    later(function () { reason = "error"; show("error"); }, AFTER_ERROR_MS);
  }

  function fileOf(address) {
    return String(address || "").replace(/[#?].*$/, "").replace(/^.*\//, "");
  }

  function onError(event) {
    var target = event && event.target;
    if (target && target !== window && target.tagName) {
      // A file that did not load. Only a script stops the app; a picture or an icon does not.
      if (target.tagName === "SCRIPT") failed("script did not load: " + fileOf(target.src));
      return;
    }
    var error = event && event.error;
    var where = event && event.filename ? " (" + fileOf(event.filename) + ":" + event.lineno + ":" + event.colno + ")" : "";
    failed((error && error.name ? error.name + ": " : "") + (error && error.message ? error.message : event && event.message) + where);
  }

  function onRejection(event) {
    var cause = event && event.reason;
    failed((cause && cause.name ? cause.name + ": " : "") + (cause && cause.message ? cause.message : String(cause)));
  }

  function watch() {
    var root = document.getElementById("root");
    if (root && window.MutationObserver) {
      observer = new MutationObserver(check);
      observer.observe(root, { childList: true });
    }
    check();
  }

  function loaded() {
    // The app may have drawn before the page finished loading: then the guard is already over.
    if (done) return;
    watch();
    if (done) return;
    later(function () { show("timeout"); }, AFTER_LOAD_MS);
    // Without a MutationObserver, and as a second look with one: the app may draw after the guard showed.
    poll = setInterval(check, 500);
  }

  window.addEventListener("error", onError, true);
  window.addEventListener("unhandledrejection", onRejection);
  if (document.readyState === "complete") loaded();
  else window.addEventListener("load", loaded);

  /** For the app's own "cannot run here" screen: the same details, and a way to say the app has drawn. */
  window.__ghostlyBoot = { details: details, clean: clean };
})();
