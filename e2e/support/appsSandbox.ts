/**
 * The malicious mini-app of e2e/web/apps-sandbox.spec.ts (WISP 1200 § Before phase 1 ships): listeners in the test
 * process that count every way a frame could reach them, and apps that try each of those ways.
 *
 * Each way has a tag. HTTP ways ask `/<tag>` of one HTTP listener; each `<link rel=preconnect>` way dials a TCP listener of its
 * own; every WebRTC way has its own STUN (UDP) and TURN (TCP) listener, so a hit names the way that got out.
 */
import { execFileSync } from "node:child_process";
import dgram from "node:dgram";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Ways out over HTTP: the probe asks `/<tag>`. */
export const HTTP_PROBES = [
  "fetch", "fetch-keepalive", "xhr", "img", "img-srcset", "picture-source", "video-poster", "css-background", "css-import",
  "css-image-set", "style-attribute", "link-stylesheet", "font", "link-prefetch", "link-preload", "link-modulepreload",
  "link-icon", "link-prerender", "speculation-rules", "script-src", "import", "worker", "shared-worker", "service-worker",
  "audio-worklet", "websocket", "eventsource", "beacon", "webtransport", "object", "embed", "iframe-src", "video", "audio",
  "track", "input-image", "svg-image", "svg-use", "base-href", "srcdoc-fetch",
] as const;

/** WebRTC, in the runner itself and in every kind of frame an app can make. */
export const RTC_PROBES = [
  "rtc-here", "rtc-webkit-prefix", "srcdoc-static", "srcdoc-classic", "srcdoc-module", "srcdoc-later", "srcdoc-nested",
  "blank-write", "data-frame", "blob-frame", "object-data", "embed-data", "javascript-url", "handler-frame", "nonce-guess",
  "re-policy",
] as const;

/** `<link rel=preconnect>`, which no policy governs in WebKit: from the entry's markup, from script, in a frame. */
export const PRECONNECT_PROBES = [
  "preconnect-static", "preconnect-shadow", "preconnect-markup", "preconnect-element", "preconnect-adjacent", "preconnect-srcdoc",
] as const;

/** Ways out that take the app's page away, or try to: each in an app of its own. */
export const ESCAPES = [
  "nav-self", "nav-meta", "nav-link", "nav-form", "nav-form-blank", "nav-top", "nav-open", "nav-link-blank", "nav-ping",
  "nav-reload", "nav-document-open", "nav-frame-top",
] as const;

export type Escape = (typeof ESCAPES)[number];

export interface ProbeTargets {
  /** The HTTP listener, `http://127.0.0.1:<port>`. */
  http: string;
  /** A preconnect listener per way. */
  preconnect: Record<string, string>;
  /** An HTTPS listener (a throwaway certificate: the context ignores HTTPS errors), `https://127.0.0.1:<port>`. */
  https: string;
  /** STUN and TURN ports per WebRTC probe. */
  rtc: Record<string, { stun: number; turn: number }>;
  host: string;
}

export interface Listeners {
  targets: ProbeTargets;
  /** Hits per tag (`/<tag>` for HTTP, `<tag>:stun` and `<tag>:turn` for WebRTC, the preconnect way's tag). */
  hits: Map<string, number>;
  reset(): void;
  /** Serves `html` at `<http>/__control`. */
  setControl(html: string): void;
  close(): Promise<void>;
}

/** Starts every listener on 127.0.0.1, on ports the system picks. */
export async function startListeners(): Promise<Listeners> {
  const host = "127.0.0.1";
  const hits = new Map<string, number>();
  const hit = (tag: string) => hits.set(tag, (hits.get(tag) ?? 0) + 1);
  const closers: (() => Promise<void>)[] = [];
  const listen = async (server: net.Server) => {
    await new Promise<void>((resolve) => server.listen(0, host, resolve));
    closers.push(() => new Promise((resolve) => { server.close(() => resolve()); (server as http.Server).closeAllConnections?.(); }));
    return (server.address() as net.AddressInfo).port;
  };

  let control = "";
  const web = http.createServer((request, response) => {
    // The control page: the same app with no runner around it, from this listener's own origin (not counted).
    if (request.url === "/__control") { response.setHeader("content-type", "text/html"); response.end(control); return; }
    hit(new URL(request.url ?? "/", "http://x").pathname.split("/")[1] || "/");
    response.setHeader("access-control-allow-origin", "*");
    response.end("x");
  });
  web.on("upgrade", (request, socket) => { hit(new URL(request.url ?? "/", "http://x").pathname.split("/")[1] || "/"); socket.destroy(); });
  const webPort = await listen(web);
  const preconnect: Record<string, string> = {};
  for (const tag of PRECONNECT_PROBES) preconnect[tag] = `http://${host}:${await listen(net.createServer((socket) => { hit(tag); socket.on("error", () => {}); socket.destroy(); }))}`;

  // HTTPS, for apps granted `internet` (and to show the others reach it no more than plain HTTP).
  const work = mkdtempSync(join(tmpdir(), "ghostly-apps-tls-"));
  execFileSync("openssl", ["req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-nodes", "-days", "1",
    "-subj", `/CN=${host}`, "-addext", `subjectAltName=IP:${host}`, "-keyout", join(work, "key.pem"), "-out", join(work, "cert.pem")], { stdio: "ignore" });
  const tls = https.createServer({ key: readFileSync(join(work, "key.pem")), cert: readFileSync(join(work, "cert.pem")) }, (request, response) => {
    hit(new URL(request.url ?? "/", "https://x").pathname.split("/")[1] || "/");
    response.setHeader("access-control-allow-origin", "*");
    response.end("x");
  });
  rmSync(work, { recursive: true, force: true });
  tls.on("upgrade", (request, socket) => { hit(new URL(request.url ?? "/", "https://x").pathname.split("/")[1] || "/"); socket.destroy(); });
  const tlsPort = await listen(tls);

  const rtc: ProbeTargets["rtc"] = {};
  for (const tag of RTC_PROBES) {
    const turn = await listen(net.createServer((socket) => { hit(`${tag}:turn`); socket.on("error", () => {}); socket.destroy(); }));
    const udp = dgram.createSocket("udp4");
    udp.on("message", () => hit(`${tag}:stun`));
    await new Promise<void>((resolve) => udp.bind(0, host, resolve));
    closers.push(() => new Promise((resolve) => udp.close(() => resolve())));
    rtc[tag] = { stun: udp.address().port, turn };
  }
  return {
    targets: { http: `http://${host}:${webPort}`, preconnect, https: `https://${host}:${tlsPort}`, rtc, host },
    hits,
    reset: () => hits.clear(),
    setControl: (html) => { control = html; },
    close: async () => { await Promise.all(closers.map((close) => close())); },
  };
}

/** The tags a set of hits names: `/fetch` as `fetch`, `srcdoc-static:stun` as `srcdoc-static`. */
export function hitTags(hits: Map<string, number>): string[] {
  return [...new Set([...hits.keys()].map((key) => key.replace(/:(stun|turn)$/, "")))].sort();
}

/* eslint-disable */
// The app's own code, run in the runner. Written as functions and sent as their source, so nothing here may name
// anything outside them; `</script>` is spelled in two pieces so the source can sit in a <script>.

/** Every way out that keeps the page, and every reading of what the app should not see. Reports to its storage. */
function netProbes(P: any) {
  const report: any = { readings: {}, errors: [] };
  const G: any = (window as any).ghostly;
  const SCRIPT_END = "<" + "/script>";
  const url = (tag: string) => P.http + "/" + tag;
  const add = (html: string) => { const d = document.createElement("div"); d.innerHTML = html; document.body.appendChild(d); return d; };
  const attempt = (name: string, f: () => unknown) => { try { f(); } catch (e: any) { report.errors.push(name + ": " + (e && e.name)); } };
  const later = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const rtcCode = (tag: string) => "try{var pc=new RTCPeerConnection({iceServers:[{urls:'stun:" + P.host + ":" + P.rtc[tag].stun + "'},{urls:'turn:" + P.host + ":" + P.rtc[tag].turn + "?transport=tcp',username:'u',credential:'p'}]});pc.createDataChannel('x');pc.createOffer().then(function(o){return pc.setLocalDescription(o)});}catch(e){}";
  const rtcScript = (tag: string, attrs = "") => "<script" + attrs + ">" + rtcCode(tag) + SCRIPT_END;
  const frame = (setup: (f: HTMLIFrameElement) => void) => { const f = document.createElement("iframe"); setup(f); document.body.appendChild(f); return f; };

  // What the app can read: where it is, and whether the runner's nonce shows anywhere.
  const r = report.readings;
  r.origin = self.origin;
  r.topIsSelf = window.top === window;
  r.ghostly = typeof G === "object" && G ? Object.keys(G).sort().join(",") : "none";
  r.rtcNames = Object.getOwnPropertyNames(window).filter((n) => /RTC/.test(n)).join(",") || "none";
  const me = document.currentScript as any;
  r.nonceProperty = me ? String(me.nonce) : "no script";
  r.nonceAttribute = me ? String(me.getAttribute("nonce")) : "no script";
  r.nonceInMarkup = Array.from(document.querySelectorAll("*")).some((e) => e.hasAttribute("nonce"));
  r.metaPolicies = document.querySelectorAll("meta[http-equiv]").length;
  attempt("localStorage", () => { r.localStorage = String(localStorage.length); });
  attempt("cookie", () => { r.cookie = document.cookie; });
  attempt("parent document", () => { r.parentDocument = String((parent as any).document.title); });
  attempt("opener", () => { r.opener = String(window.opener); });
  const found: string[] = [];
  r.found = found;
  attempt("violation listener", () => addEventListener("securitypolicyviolation", (e: any) => { if (e.originalPolicy) found.push("violation: " + e.originalPolicy); }));
  attempt("reporting observer", () => { new (window as any).ReportingObserver((reports: any[]) => { for (const x of reports) found.push("report: " + JSON.stringify(x.body)); }, { buffered: true }).observe(); });
  attempt("mutation observer", () => new MutationObserver((records) => { for (const record of records) for (const n of Array.from(record.addedNodes) as any[]) { if (n.nonce) found.push("mutation: " + n.nonce); if (n.getAttribute && n.getAttribute("nonce")) found.push("mutation attribute"); } }).observe(document, { subtree: true, childList: true, attributes: true }));
  attempt("performance", () => { r.performance = performance.getEntries().map((e) => e.name).filter((n) => /nonce/.test(n)).length; });
  attempt("broadcast", () => new BroadcastChannel("ghostly").postMessage("from the app"));
  attempt("post to parent", () => parent.postMessage({ ghostly: "port", from: "app" }, "*", [new MessageChannel().port2]));
  attempt("post to frames", () => { for (let i = 0; i < parent.frames.length; i++) parent.frames[i]!.postMessage({ ghostly: "port", from: "app" }, "*", [new MessageChannel().port2]); });

  // (b) Every way to the network that keeps the page.
  attempt("fetch", () => { fetch(url("fetch"), { mode: "no-cors" }).catch(() => {}); });
  attempt("fetch-keepalive", () => { fetch(url("fetch-keepalive"), { mode: "no-cors", keepalive: true, method: "POST", body: "x" }).catch(() => {}); });
  attempt("https-fetch", () => { fetch(P.https + "/https-fetch", { mode: "no-cors" }).catch(() => {}); });
  attempt("https-img", () => { new Image().src = P.https + "/https-img"; });
  attempt("wss", () => { new WebSocket(P.https.replace("https:", "wss:") + "/wss"); });
  attempt("xhr", () => { const x = new XMLHttpRequest(); x.open("GET", url("xhr")); x.send(); });
  attempt("img", () => { new Image().src = url("img"); });
  add(`<img srcset="${url("img-srcset")} 1x"><picture><source srcset="${url("picture-source")}"><img></picture><video poster="${url("video-poster")}"></video>`);
  add(`<style>body{background:url(${url("css-background")})}</style><style>@import url(${url("css-import")});</style><style>html{background-image:image-set("${url("css-image-set")}" 1x)}</style><div style="background:url(${url("style-attribute")})">x</div>`);
  add(`<style>@font-face{font-family:probe;src:url(${url("font")})}</style><span style="font-family:probe">x</span>`);
  add(`<link rel="stylesheet" href="${url("link-stylesheet")}"><link rel="prefetch" href="${url("link-prefetch")}"><link rel="preload" as="image" href="${url("link-preload")}"><link rel="modulepreload" href="${url("link-modulepreload")}"><link rel="icon" href="${url("link-icon")}"><link rel="prerender" href="${url("link-prerender")}">`);
  add(`<link rel="preconnect" href="${P.preconnect["preconnect-markup"]}"><link rel="dns-prefetch" href="${P.preconnect["preconnect-markup"]}">`);
  attempt("preconnect-element", () => { const l = document.createElement("link"); l.rel = "preconnect"; l.href = P.preconnect["preconnect-element"]; document.head.appendChild(l); });
  attempt("preconnect-adjacent", () => document.body.insertAdjacentHTML("beforeend", `<link rel="preconnect" href="${P.preconnect["preconnect-adjacent"]}">`));
  frame((f) => { f.srcdoc = `<link rel="preconnect" href="${P.preconnect["preconnect-srcdoc"]}">`; });
  attempt("speculation-rules", () => { const s = document.createElement("script"); s.type = "speculationrules"; s.textContent = JSON.stringify({ prefetch: [{ source: "list", urls: [url("speculation-rules")] }] }); document.head.appendChild(s); });
  attempt("script-src", () => { const s = document.createElement("script"); s.src = url("script-src"); document.head.appendChild(s); });
  attempt("import", () => { (0, eval)("1"); });
  attempt("import()", () => { import(/* @vite-ignore */ url("import")).catch(() => {}); });
  attempt("worker", () => { new Worker(url("worker")); });
  attempt("shared-worker", () => { new SharedWorker(url("shared-worker")); });
  attempt("service-worker", () => { navigator.serviceWorker.register(url("service-worker")).catch(() => {}); });
  attempt("audio-worklet", () => { new AudioContext().audioWorklet.addModule(url("audio-worklet")).catch(() => {}); });
  attempt("websocket", () => { new WebSocket(url("websocket").replace("http:", "ws:")); });
  attempt("eventsource", () => { new EventSource(url("eventsource")); });
  attempt("beacon", () => { navigator.sendBeacon(url("beacon"), "x"); });
  attempt("webtransport", () => { new (window as any).WebTransport(url("webtransport").replace("http:", "https:")).ready.catch(() => {}); });
  add(`<object data="${url("object")}"></object><embed src="${url("embed")}"><iframe src="${url("iframe-src")}"></iframe>`);
  add(`<video src="${url("video")}" preload="auto"></video><audio src="${url("audio")}" preload="auto"></audio><video><track default src="${url("track")}"></video>`);
  add(`<input type="image" src="${url("input-image")}"><svg><image href="${url("svg-image")}" width="1" height="1"/><use href="${url("svg-use")}#x"/></svg>`);
  attempt("base-href", () => { const b = document.createElement("base"); b.href = P.http + "/"; document.head.appendChild(b); add(`<img src="base-href">`); });

  // (c) WebRTC: here (the constructors are gone), and in each kind of frame, which brings its own.
  attempt("rtc-here", () => { (0, eval)(rtcCode("rtc-here")); });
  attempt("rtc-webkit-prefix", () => { const C = (window as any).webkitRTCPeerConnection; if (C) new C({ iceServers: [{ urls: "stun:" + P.host + ":" + P.rtc["rtc-webkit-prefix"].stun }] }); });
  frame((f) => { f.srcdoc = rtcScript("srcdoc-classic"); });
  frame((f) => { f.srcdoc = "<script>fetch('" + url("srcdoc-fetch") + "')" + SCRIPT_END; });
  attempt("blank-write", () => { const f = frame(() => {}); const d = f.contentDocument; if (d) { d.open(); d.write(rtcScript("blank-write")); d.close(); r.blankWrite = "wrote"; } else r.blankWrite = "no access"; });
  frame((f) => { f.src = "data:text/html," + encodeURIComponent(rtcScript("data-frame")); });
  frame((f) => { f.src = URL.createObjectURL(new Blob([rtcScript("blob-frame")], { type: "text/html" })); });
  add(`<object type="text/html" data="data:text/html,${encodeURIComponent(rtcScript("object-data"))}"></object><embed type="text/html" src="data:text/html,${encodeURIComponent(rtcScript("embed-data"))}">`);
  frame((f) => { f.src = "javascript:" + encodeURIComponent(JSON.stringify(rtcScript("javascript-url"))); });
  frame((f) => { f.srcdoc = "<img src=\"data:,\" onerror=\"" + rtcCode("handler-frame").replace(/"/g, "&quot;") + "\">"; });
  attempt("re-policy", () => {
    const m = document.createElement("meta"); m.httpEquiv = "Content-Security-Policy"; m.content = "script-src 'unsafe-inline' 'unsafe-eval'"; document.head.appendChild(m);
    frame((f) => { f.srcdoc = rtcScript("re-policy"); });
  });
  setTimeout(() => frame((f) => { f.srcdoc = rtcScript("srcdoc-later"); }), 300);
  setTimeout(() => {
    const guesses = [r.nonceProperty, r.nonceAttribute, ...found.map((x) => (/nonce-([0-9a-f]+)/.exec(x) || [])[1])].filter((n) => n && n !== "undefined" && n !== "null");
    r.guesses = guesses.length;
    for (const n of guesses.length ? guesses : ["0"]) frame((f) => { f.srcdoc = rtcScript("nonce-guess", ' nonce="' + n + '"'); });
  }, 1000);

  // (d) The broker, with another app's name in every field it might read.
  (async () => {
    await later(4000);
    const forged = (G as any);
    try { r.otherSecret = JSON.stringify(await forged.storage.get("secret", { ref: P.victim, app: P.victim, scope: "alone" })); } catch (e: any) { r.otherSecret = "refused: " + e.message; }
    try { await forged.storage.set("report-probe", { ref: P.victim }); r.storageSet = "ok"; } catch (e: any) { r.storageSet = "refused: " + e.message; }
    try { r.context = await G.context(); } catch (e: any) { r.context = "refused: " + e.message; }
    try { await G.chat.send({ hello: 1 }); r.chatSend = "sent"; } catch (e: any) { r.chatSend = "refused: " + e.message; }
    report.done = true;
    await G.storage.set("report", JSON.parse(JSON.stringify(report)));
  })();
}

/** Ways out that take the page with them: the one named in P.escape. */
function escapeProbe(P: any) {
  const url = (tag: string) => P.http + "/" + tag;
  const add = (html: string) => { const d = document.createElement("div"); d.innerHTML = html; document.body.appendChild(d); return d; };
  const G: any = (window as any).ghostly;
  const go: Record<string, () => void> = {
    "nav-self": () => { location.href = url("nav-self"); },
    "nav-meta": () => { const m = document.createElement("meta"); m.httpEquiv = "refresh"; m.content = "0;url=" + url("nav-meta"); document.head.appendChild(m); },
    "nav-link": () => { (add(`<a href="${url("nav-link")}">x</a>`).querySelector("a") as HTMLAnchorElement).click(); },
    "nav-form": () => { (add(`<form method="post" action="${url("nav-form")}"><input name="secret" value="x"></form>`).querySelector("form") as HTMLFormElement).submit(); },
    "nav-form-blank": () => { (add(`<form method="post" target="_blank" action="${url("nav-form-blank")}"><input name="secret" value="x"></form>`).querySelector("form") as HTMLFormElement).submit(); },
    "nav-top": () => { try { (top as any).location.href = url("nav-top"); } catch (e) { /* refused */ } },
    "nav-open": () => { window.open(url("nav-open")); },
    "nav-link-blank": () => { (add(`<a target="_blank" href="${url("nav-link-blank")}">x</a>`).querySelector("a") as HTMLAnchorElement).click(); },
    "nav-ping": () => { (add(`<a ping="${url("nav-ping")}" href="${url("nav-ping-href")}">x</a>`).querySelector("a") as HTMLAnchorElement).click(); },
    "nav-reload": () => { location.reload(); },
    // document.write is refused to apps; open and close alone are a new document, and a load.
    "nav-document-open": () => { document.open(); try { document.write("<iframe srcdoc=\"<p>replaced</p>\"></iframe>"); } catch (e) { /* refused */ } document.close(); },
    "nav-frame-top": () => { const f = document.createElement("iframe"); f.srcdoc = "<script>top.location.href='" + url("nav-frame-top") + "'<" + "/script>"; document.body.appendChild(f); },
  };
  G.storage.set("started", true).then(() => setTimeout(go[P.escape]!, 100));
}

/** An app granted `internet`: HTTPS and WSS go out; plain HTTP, remote script, frames and WebRTC do not. */
function internetApp(P: any) {
  const G: any = (window as any).ghostly;
  const add = (html: string) => { const d = document.createElement("div"); d.innerHTML = html; document.body.appendChild(d); };
  const report: any = {};
  (async () => {
    try { report.fetch = (await (await fetch(P.https + "/net-fetch")).text()); } catch (e: any) { report.fetch = "refused: " + e.name; }
    try { await fetch(P.http + "/net-http", { mode: "no-cors" }); report.http = "fetched"; } catch (e: any) { report.http = "refused: " + e.name; }
    new Image().src = P.https + "/net-img";
    try { new WebSocket(P.https.replace("https:", "wss:") + "/net-wss"); } catch (e: any) { report.wss = "threw " + e.name; }
    add(`<img src="${P.http}/net-http-img"><iframe src="${P.https}/net-frame"></iframe>`);
    try { const s = document.createElement("script"); s.src = P.https + "/net-script"; document.head.appendChild(s); } catch (e) { /* refused */ }
    try { const f = document.createElement("form"); f.method = "post"; f.action = P.https + "/net-form"; document.body.appendChild(f); f.submit(); } catch (e) { /* refused */ }
    report.rtc = Object.getOwnPropertyNames(window).filter((n) => /RTC/.test(n)).join(",") || "none";
    await new Promise((r) => setTimeout(r, 1500));
    await G.storage.set("report", report);
  })();
}

/** An honest app with something to keep: what the impostor tries to read. */
function victimApp() {
  (window as any).ghostly.storage.set("secret", "the victim's").then(() => (window as any).ghostly.storage.set("ready", true));
}

/** Floods the broker and sends one request too large, then reports what it was told. */
function floodApp() {
  const G: any = (window as any).ghostly;
  (async () => {
    const answers = await Promise.allSettled(Array.from({ length: 200 }, () => G.storage.keys()));
    const refused = answers.filter((a) => a.status === "rejected").map((a: any) => a.reason.message);
    await new Promise((r) => setTimeout(r, 1100));
    let large = "sent";
    try { await G.storage.set("big", "x".repeat(64 * 1024)); } catch (e: any) { large = e.message; }
    await G.storage.set("report", { ok: answers.length - refused.length, refused: [...new Set(refused)], large });
  })();
}
/* eslint-enable */

const SOURCES = { net: netProbes, escape: escapeProbe, victim: victimApp, flood: floodApp, internet: internetApp } as const;

/** An app's entry: the probe's source, given its targets. */
export function appEntry(kind: keyof typeof SOURCES, targets: object = {}): string {
  const P = targets as Record<string, unknown>;
  const source = `(${SOURCES[kind].toString()})(${JSON.stringify(P)});`.replace(/<\/(script)/gi, "<\\/$1");
  // The static frames come from the markup itself, before any script of the app runs: frames the parser makes.
  const rtc = P.rtc as ProbeTargets["rtc"] | undefined;
  const staticFrames = kind === "net" && rtc ? (() => {
    const code = (tag: string) => `try{var pc=new RTCPeerConnection({iceServers:[{urls:'stun:${P.host}:${rtc[tag]!.stun}'},{urls:'turn:${P.host}:${rtc[tag]!.turn}?transport=tcp',username:'u',credential:'p'}]});pc.createDataChannel('x');pc.createOffer().then(function(o){return pc.setLocalDescription(o)});}catch(e){}`;
    const attr = (text: string) => text.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
    const script = (tag: string) => `<script>${code(tag)}</script>`;
    const pre = P.preconnect as Record<string, string>;
    return `<link rel="preconnect" href="${pre["preconnect-static"]}"><div><template shadowrootmode="open"><link rel="preconnect" href="${pre["preconnect-shadow"]}"></template></div>`
      + `<iframe srcdoc="${attr(script("srcdoc-static"))}"></iframe><iframe srcdoc="${attr(`<iframe srcdoc="${attr(script("srcdoc-nested"))}"></iframe>`)}"></iframe>`
      + `<script type="module">{const f=document.createElement("iframe");f.srcdoc=${JSON.stringify(script("srcdoc-module")).replace(/<\//g, "<\\/")};document.body.appendChild(f);}</script>`;
  })() : "";
  return `<!doctype html><html><head><meta charset="utf-8"><title>${kind}</title></head><body><p>Nothing to see here.</p>${staticFrames}<script>${source}</script></body></html>`;
}
