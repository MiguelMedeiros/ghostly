import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const CHECK = join(import.meta.dirname, "../check-web-first-load.mjs");
const dirs: string[] = [];

/** The chunks today's build keeps for later, each a file of its own: the online-only ones, a group call, OpenPGP. */
const LATER = ["pubky-a1.js", "keet-identity-key-b2.js", "usdt-c3.js", "arkade-d4.js", "groupCallLivekit-e5.js", "openpgp.min-f6.js"];

interface Page { src: string[]; preload?: string[] }

/**
 * A web build as vite writes it: its two pages (each `src` a module script, each `preload` a modulepreload), and in
 * assets/ every file a page names plus `assets` (today's later chunks by default), each of `bytes` bytes or 1 KB of
 * code, or the text `text` gives it.
 */
function dist(app: Page, signIn: Page, { assets = LATER, bytes = {}, text = {} }: { assets?: string[]; bytes?: Record<string, number>; text?: Record<string, string> } = {}): string {
  const dir = mkdtempSync(join(tmpdir(), "ghostly-web-first-load-"));
  dirs.push(dir);
  const page = ({ src, preload = [] }: Page) => [
    "<!doctype html><html><head>",
    ...src.map((file) => `    <script type="module" crossorigin src="/assets/${file}"></script>`),
    ...preload.map((file) => `    <link rel="modulepreload" crossorigin href="/assets/${file}">`),
    "</head><body></body></html>",
  ].join("\n");
  writeFileSync(join(dir, "index.html"), page(app));
  writeFileSync(join(dir, "oidc-callback.html"), page(signIn));
  mkdirSync(join(dir, "assets"));
  for (const file of new Set([...app.src, ...(app.preload ?? []), ...signIn.src, ...(signIn.preload ?? []), ...assets])) {
    const path = join(dir, "assets", file);
    if (text[file] !== undefined) {
      writeFileSync(path, text[file]);
    } else {
      writeFileSync(path, `import{a as e}from"./main-c.js";export const run=()=>e();`);
      truncateSync(path, bytes[file] ?? 1024);
    }
  }
  return dir;
}

const check = (dir: string) => spawnSync(process.execPath, [CHECK, dir], { encoding: "utf8" });

/** Today's first load: the runtime, popup and main, with main at its 4.5 MB. */
const TODAY = { src: ["rolldown-runtime-a.js", "popup-b.js", "main-c.js"] };
const SIGN_IN = { src: ["oidcCallback-d.js"], preload: ["popup-b.js"] };

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("check-web-first-load", () => {
  it("passes the app in one main file beside the runtime, its later chunks on their own, and a sign-in page sharing only popup", () => {
    const result = check(dist(TODAY, SIGN_IN, { bytes: { "main-c.js": 4_499_914 } }));
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
  });

  it("fails a first load split into many files again", () => {
    const split = Array.from({ length: 90 }, (_, i) => `chunk${i}-x.js`);
    const result = check(dist({ src: ["main-c.js"], preload: split }, { src: ["oidcCallback-d.js"] }));
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("index.html asks for 91 scripts (at most 4)");
  });

  it("fails an entry not named main-*.js, which the e2e specs hold back", () => {
    const result = check(dist({ src: ["rolldown-runtime-a.js", "initial-c.js"] }, { src: ["oidcCallback-d.js"] }));
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("names 0 main-*.js files");
  });

  it("fails a sign-in page that loads the app", () => {
    const result = check(dist({ src: ["rolldown-runtime-a.js", "main-c.js"] }, { src: ["oidcCallback-d.js"], preload: ["rolldown-runtime-a.js", "main-c.js"] }));
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("oidc-callback.html loads the app's own /assets/main-c.js");
  });

  it("fails without a build", () => {
    const result = check(join(tmpdir(), "ghostly-web-first-load-none"));
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Run `npm run build:web` first.");
  });

  it("fails pages it finds no script in, rather than passing them unchecked", () => {
    const dir = dist({ src: [] }, { src: [] });
    // A relative base: the same first load under ./assets, which the check does not read.
    writeFileSync(join(dir, "index.html"), `<script type="module" crossorigin src="./assets/main-c.js"></script>`);
    const result = check(dir);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("index.html names no /assets/*.js script, so there is nothing to check");
    expect(result.stderr).toContain("oidc-callback.html names no /assets/*.js script");
  });

  it("fails an online-only chunk folded into the entry, as main's group without its $initial tag does", () => {
    // What that build leaves: a pubky file of a hundred bytes re-exporting main's. Main grown by pubky alone stays
    // under the ceiling, so this rule is what catches it.
    const stub = `export{$t as AuthFlow,en as AuthFlowKind,ln as GrantAuthFlow,Sn as Pubky}from"./main-c.js";`;
    const result = check(dist(TODAY, SIGN_IN, { text: { "pubky-a1.js": stub }, bytes: { "main-c.js": 4_499_914 + 3_488_315 } }));
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("pubky-a1.js only passes on main's exports: pubky was folded into main");
    expect(result.stderr).not.toContain("ceiling");
  });

  it("fails a later chunk with no file of its own", () => {
    const result = check(dist(TODAY, SIGN_IN, { assets: LATER.filter((file) => !file.startsWith("usdt-")) }));
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("No usdt-*.js in assets/: it was folded into another chunk, likely main");
  });

  it("fails a later chunk the first load asks for", () => {
    const result = check(dist({ src: [...TODAY.src, "openpgp.min-f6.js"] }, SIGN_IN));
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("index.html loads /assets/openpgp.min-f6.js, which the app should load only when it is used");
  });

  it("fails a first load over the byte ceiling, whatever grew it", () => {
    const result = check(dist(TODAY, SIGN_IN, { bytes: { "main-c.js": 9_000_000 } }));
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("index.html's scripts weigh 9,002,048 B, over the 9,000,000 B ceiling");
  });
});
