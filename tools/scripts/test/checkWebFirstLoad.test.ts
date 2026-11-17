import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const CHECK = join(import.meta.dirname, "../check-web-first-load.mjs");
const dirs: string[] = [];

/** A web build's two pages, as vite writes them: each `src` a module script, each `preload` a modulepreload. */
function dist(app: { src: string[]; preload?: string[] }, signIn: { src: string[]; preload?: string[] }): string {
  const dir = mkdtempSync(join(tmpdir(), "ghostly-web-first-load-"));
  dirs.push(dir);
  const page = ({ src, preload = [] }: { src: string[]; preload?: string[] }) => [
    "<!doctype html><html><head>",
    ...src.map((file) => `    <script type="module" crossorigin src="/assets/${file}"></script>`),
    ...preload.map((file) => `    <link rel="modulepreload" crossorigin href="/assets/${file}">`),
    "</head><body></body></html>",
  ].join("\n");
  writeFileSync(join(dir, "index.html"), page(app));
  writeFileSync(join(dir, "oidc-callback.html"), page(signIn));
  return dir;
}

const check = (dir: string) => spawnSync(process.execPath, [CHECK, dir], { encoding: "utf8" });

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("check-web-first-load", () => {
  it("passes the app in one main file beside the runtime, and a sign-in page sharing only popup", () => {
    const result = check(dist({ src: ["rolldown-runtime-a.js", "popup-b.js", "main-c.js"] }, { src: ["oidcCallback-d.js"], preload: ["popup-b.js"] }));
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
});
