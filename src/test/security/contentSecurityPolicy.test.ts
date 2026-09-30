import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { IMAGE_HOSTS, IMAGE_REDIRECTS } from "@ghostly/browser/profiles/public";

// covers: files.voice.play

/**
 * Every shell that serves the UI has its own Content-Security-Policy, and the browser engine enforces each one
 * on its own. A directive missing from one of them breaks only that shell: #194's voice messages played in the
 * web app and the extension, and every one of them failed on Desktop with "Could not play this recording.",
 * because Tauri's policy had no `media-src` and `<audio src="blob:…">` fell back to `default-src 'self'`.
 * The e2e suite runs the web build, which has no policy at all, so only a test that reads the policies sees it.
 */
const read = (path: string) => readFileSync(join(import.meta.dirname, "../../..", path), "utf8");

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

describe("HTTPS only", () => {
  // Both sites are served over HTTPS by Cloudflare, which added no Strict-Transport-Security of its own, so a browser
  // given the bare name could try plain HTTP first. The servers say it themselves.
  it("the web app's server and the website send Strict-Transport-Security for a year", () => {
    expect(read("apps/web/nginx-headers.conf")).toMatch(/^add_header Strict-Transport-Security "max-age=31536000" always;$/m);
    expect(read("website/next.config.ts")).toMatch(/key: "Strict-Transport-Security", value: "max-age=31536000"/);
  });
});
