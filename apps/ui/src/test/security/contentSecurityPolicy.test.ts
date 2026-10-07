import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { IMAGE_HOSTS, IMAGE_REDIRECTS } from "@ghostly/browser/profiles/public";
import { NET_RUNNER_CSP, NET_RUNNER_HEADERS, RUNNER_CSP, RUNNER_HEADERS } from "../../../../web/runnerPolicy";

// covers: files.voice.play

/**
 * Every shell that serves the UI has its own Content-Security-Policy, and the browser engine enforces each one
 * on its own. A directive missing from one of them breaks only that shell: #194's voice messages played in the
 * web app and the extension, and every one of them failed on Desktop with "Could not play this recording.",
 * because Tauri's policy had no `media-src` and `<audio src="blob:…">` fell back to `default-src 'self'`.
 * The e2e suite runs the web build, which has no policy at all, so only a test that reads the policies sees it.
 */
const read = (path: string) => readFileSync(join(import.meta.dirname, "../../../../..", path), "utf8");

/** `directive → sources`, as a browser reads a policy. */
function directives(policy: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const part of policy.split(";")) {
    const [name, ...sources] = part.trim().split(/\s+/);
    if (name && !out.has(name)) out.set(name.toLowerCase(), sources);
  }
  return out;
}

/** The sources a fetch of this kind is checked against: its own directive, else `default-src`, else anything. */
function allowed(policy: string, directive: string): string[] | "anything" {
  const parsed = directives(policy);
  return parsed.get(directive) ?? parsed.get("default-src") ?? "anything";
}

const policies = {
  desktop: () => (JSON.parse(read("apps/desktop/tauri.conf.json")) as { app: { security: { csp: string } } }).app.security.csp,
  web: () => /Content-Security-Policy "([^"]+)"/.exec(read("apps/web/nginx-headers.conf"))![1]!,
  extension: () => (JSON.parse(read("apps/extension/public/manifest.json")) as { content_security_policy: { extension_pages: string } }).content_security_policy.extension_pages,
};

describe("the Content-Security-Policy of every shell", () => {
  it.each(Object.keys(policies) as (keyof typeof policies)[])("%s plays audio and video from blob: URLs (voice messages, received media)", (shell) => {
    const media = allowed(policies[shell](), "media-src");
    if (media !== "anything") expect(media).toContain("blob:");
  });

  // covers: chat.location.card, chat.link-preview.render
  it.each(Object.keys(policies) as (keyof typeof policies)[])("%s shows link-preview thumbnails (data:) and OpenStreetMap tiles on tap", (shell) => {
    const images = allowed(policies[shell](), "img-src");
    if (images === "anything") return;
    expect(images).toContain("data:");
    expect(images).toContain("https://tile.openstreetmap.org");
  });

  // covers: proofs.public-profile.picture
  it.each(Object.keys(policies) as (keyof typeof policies)[])("%s fetches profile pictures from the fixed hosts (connect-src) and shows them as data: (img-src)", (shell) => {
    const connect = allowed(policies[shell](), "connect-src");
    const images = allowed(policies[shell](), "img-src");
    // The engine fetches the picture and re-encodes it: the page only ever shows a data: URL.
    if (images !== "anything") expect(images).toContain("data:");
    if (connect === "anything") return;
    const hosts = [...IMAGE_HOSTS, ...Object.values(IMAGE_REDIRECTS).flatMap(s => [...s])];
    for (const host of hosts) expect(connect.includes("https:") || connect.includes(`https://${host}`), `${shell} connect-src reaches ${host}`).toBe(true);
  });

  // covers: app.attention.sounds, app.attention.cues
  it.each(Object.keys(policies) as (keyof typeof policies)[])("%s fetches the app's own sounds (Web Audio decodes what fetch brings, so connect-src, not media-src)", (shell) => {
    const connect = allowed(policies[shell](), "connect-src");
    if (connect !== "anything") expect(connect).toContain("'self'");
  });

  it("keeps every sound a file of its own: Vite inlines an asset under 4 KiB as a data: URL, which connect-src 'self' refuses", () => {
    const folder = join(import.meta.dirname, "../../assets/sounds");
    for (const name of readdirSync(folder).filter(f => f.endsWith(".mp3"))) expect(statSync(join(folder, name)).size, name).toBeGreaterThan(4096);
  });

  // covers: files.video.stream
  it("names media-src on Desktop, rather than leaning on default-src: blobs and the stored-file scheme, nothing wider", () => {
    // Rust serves a stored file in ranges (apps/desktop/src/file_stream.rs): `ghostly-file://localhost/…` on macOS,
    // `http://ghostly-file.localhost/…` on Windows, where WebView2 takes no custom scheme, and HTTP on 127.0.0.1 on
    // Linux, whose WebKitGTK plays media from no custom scheme (connect-src already reaches 127.0.0.1).
    expect(directives(policies.desktop()).get("media-src")).toEqual(["'self'", "blob:", "ghostly-file:", "http://ghostly-file.localhost", "http://127.0.0.1:*"]);
    expect(directives(policies.desktop()).get("connect-src")).toContain("http://127.0.0.1:*");
  });

  it("gives the stored-file scheme to no other kind of fetch, and to no other shell", () => {
    const desktop = directives(policies.desktop());
    for (const [name, sources] of desktop) if (name !== "media-src") expect(sources.join(" "), name).not.toContain("ghostly-file");
    expect(policies.web()).not.toContain("ghostly-file");
    expect(policies.extension()).not.toContain("ghostly-file");
  });

  it("the parser reads a policy as a browser does", () => {
    expect(allowed("default-src 'self'; img-src blob:", "media-src")).toEqual(["'self'"]);
    expect(allowed("img-src blob:", "media-src")).toBe("anything");
    expect(allowed("default-src 'self'; media-src 'self' blob:; media-src 'none'", "media-src")).toEqual(["'self'", "blob:"]);
  });
});

// covers: apps.web-sandbox
describe("the mini-app runner (WISP 1200, \"The runner's CSP\")", () => {
  const nginx = read("apps/web/nginx.conf");
  /** nginx's `location` blocks: what each matches, and what is inside. */
  const locations = [...nginx.matchAll(/location\s+([^{]+?)\s*\{([^}]*)\}/g)].map(([, match, body]) => ({ match: match!.trim(), body: body! }));
  const runner = locations.find((l) => l.match === "= /app-frame.html");
  const header = (body: string, name: string) => new RegExp(`add_header ${name} "([^"]+)" always;`).exec(body)?.[1];

  it("the web page may frame only its own origin", () => {
    expect(directives(policies.web()).get("frame-src")).toEqual(["'self'"]);
    expect(directives(policies.web()).get("frame-ancestors")).toEqual(["'none'"]);
  });

  it("the runner's location sends the runner's policy, the same on the web, in Vite's servers and on Desktop", () => {
    expect(runner, "a location for /app-frame.html").toBeDefined();
    expect(header(runner!.body, "Content-Security-Policy")).toBe(RUNNER_CSP);
    expect(RUNNER_HEADERS["Content-Security-Policy"]).toBe(RUNNER_CSP);
    const desktop = /pub const RUNNER_CSP: &str = "([^"]*)";/.exec(read("apps/desktop/src/app_sandbox.rs"))![1]!.replace(/\\\n/g, "");
    expect(desktop).toBe(RUNNER_CSP);
    const d = directives(RUNNER_CSP);
    expect(d.get("sandbox")).toEqual(["allow-scripts"]);
    expect(d.get("frame-ancestors")).toEqual(["'self'"]);
    for (const name of ["default-src", "connect-src", "frame-src", "worker-src", "form-action", "base-uri"]) expect(d.get(name), name).toEqual(["'none'"]);
    expect(d.get("script-src")).toEqual(["'unsafe-inline'", "'wasm-unsafe-eval'"]);
  });

  it("does not carry the page's policy (two policies intersect), and repeats every other header itself", () => {
    expect(runner!.body).not.toContain("ghostly-headers.conf");
    const common = read("apps/web/nginx-headers.conf");
    for (const name of ["X-Content-Type-Options", "Referrer-Policy", "Strict-Transport-Security"]) {
      expect(header(runner!.body, name), name).toBe(header(common, name));
    }
    expect(header(runner!.body, "Permissions-Policy")).toBe(RUNNER_HEADERS["Permissions-Policy"]);
    for (const name of ["X-Content-Type-Options", "Referrer-Policy", "Permissions-Policy", "X-DNS-Prefetch-Control"]) expect(RUNNER_HEADERS[name], name).toBe(header(runner!.body, name));
  });

  it("the network runner (apps granted internet) is the same file under a policy that adds HTTPS and WSS, and nothing else", () => {
    const net = locations.find((l) => l.match === "= /app-frame-net.html");
    expect(net, "a location for /app-frame-net.html").toBeDefined();
    expect(net!.body).toContain("try_files /app-frame.html =404;");
    expect(net!.body).not.toContain("ghostly-headers.conf");
    expect(header(net!.body, "Content-Security-Policy")).toBe(NET_RUNNER_CSP);
    expect(NET_RUNNER_HEADERS["Content-Security-Policy"]).toBe(NET_RUNNER_CSP);
    // Desktop's `ghostly-app` scheme serves the same policy to an app window granted internet.
    const desktop = /pub const NET_RUNNER_CSP: &str = "([^"]*)";/.exec(read("apps/desktop/src/app_sandbox.rs"))![1]!.replace(/\\\n/g, "");
    expect(desktop).toBe(NET_RUNNER_CSP);
    for (const name of ["X-Content-Type-Options", "Referrer-Policy", "Permissions-Policy", "X-DNS-Prefetch-Control", "Strict-Transport-Security"]) expect(header(net!.body, name), name).toBe(header(runner!.body, name));
    const plain = directives(RUNNER_CSP);
    const wide = directives(NET_RUNNER_CSP);
    expect(wide.get("connect-src")).toEqual(["https:", "wss:"]);
    for (const name of ["img-src", "media-src", "font-src"]) expect(wide.get(name), name).toEqual([...plain.get(name)!, "https:"]);
    for (const [name, sources] of plain) if (!["connect-src", "img-src", "media-src", "font-src"].includes(name)) expect(wide.get(name), name).toEqual(sources);
    expect([...wide.keys()].sort()).toEqual([...plain.keys()].sort());
  });

  it("every other location keeps the page's policy, and with it frame-ancestors 'none'", () => {
    const net = locations.find((l) => l.match === "= /app-frame-net.html");
    for (const location of locations.filter((l) => l !== runner && l !== net)) {
      if (/^\s*return\s/.test(location.body.trim())) continue; // a redirect, no page
      expect(location.body, location.match).toContain("include /etc/nginx/ghostly-headers.conf;");
    }
  });
});

describe("HTTPS only", () => {
  // Both sites are served over HTTPS by Cloudflare, which added no Strict-Transport-Security of its own, so a browser
  // given the bare name could try plain HTTP first. The servers say it themselves.
  it("the web app's server and the website send Strict-Transport-Security for a year", () => {
    expect(read("apps/web/nginx-headers.conf")).toMatch(/^add_header Strict-Transport-Security "max-age=31536000" always;$/m);
    expect(read("apps/website/next.config.ts")).toMatch(/key: "Strict-Transport-Security", value: "max-age=31536000"/);
  });
});
