import { readFileSync } from "node:fs";
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
  desktop: () => (JSON.parse(read("src-tauri/tauri.conf.json")) as { app: { security: { csp: string } } }).app.security.csp,
  web: () => /Content-Security-Policy "([^"]+)"/.exec(read("web/nginx-headers.conf"))![1]!,
  extension: () => (JSON.parse(read("extension/public/manifest.json")) as { content_security_policy: { extension_pages: string } }).content_security_policy.extension_pages,
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

  it("names media-src on Desktop, rather than leaning on default-src", () => {
    expect(directives(policies.desktop()).get("media-src")).toEqual(["'self'", "blob:"]);
  });

  it("the parser reads a policy as a browser does", () => {
    expect(allowed("default-src 'self'; img-src blob:", "media-src")).toEqual(["'self'"]);
    expect(allowed("img-src blob:", "media-src")).toBe("anything");
    expect(allowed("default-src 'self'; media-src 'self' blob:; media-src 'none'", "media-src")).toEqual(["'self'", "blob:"]);
  });
});
