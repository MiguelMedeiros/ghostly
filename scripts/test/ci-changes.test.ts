import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { PACKAGES_READ_FROM_SITE, WEBSITE_INPUTS, covers, plan } from "../ci-changes.mjs";
import { FILES as DECK } from "../../website/scripts/sync-app-deck.mjs";

const root = resolve(import.meta.dirname, "../..");

describe("the website gate", () => {
  it("covers every app file the deck check compares", () => {
    for (const file of DECK) expect(covers(WEBSITE_INPUTS, `src/components/${file}`), `src/components/${file}`).toBe(true);
  });

  it("covers every repository file and folder the site's scripts name", () => {
    // The site's own scripts (not capture/, a manual tool) read the repository by root-relative literals:
    // sync-references.mjs's documents, folder and excerpts, check-dashes.mjs's list. Any that names an existing file
    // or folder outside website/ is an input. The deck's folder, src/components, is read file by file (above).
    const dir = join(root, "website/scripts");
    const named = readdirSync(dir)
      .filter((f) => f.endsWith(".mjs"))
      .flatMap((f) => [...readFileSync(join(dir, f), "utf8").matchAll(/["'`]([\w.-]+(?:\/[\w.-]+)*)["'`]/g)].map((m) => m[1]))
      .filter((p) => p.includes("/") || p.endsWith(".md"))
      .filter((p) => !p.startsWith(".") && !p.startsWith("website/") && p !== "src/components");
    const kind = (p: string) => {
      try {
        return statSync(join(root, p)).isDirectory() ? "folder" : "file";
      } catch {
        return null;
      }
    };
    const files = named.filter((p) => kind(p) === "file");
    const folders = named.filter((p) => kind(p) === "folder");
    expect(files).toEqual(expect.arrayContaining(["packages/core/src/invite.ts", "packages/core/src/pairedTransports.ts", "docs/PROTOCOL.md", "CONTRIBUTING.md"]));
    expect(folders).toContain("docs/wisps");
    for (const file of files) expect(covers(WEBSITE_INPUTS, file), file).toBe(true);
    for (const folder of folders) expect(covers(WEBSITE_INPUTS, `${folder}/any.md`), `${folder}/`).toBe(true);
  });
});

describe("the packages gate", () => {
  it("covers every site file the packages' tests and sources name, and they name no document", () => {
    // What `npm run test:packages` runs: packages/* and extension/, their sources, tests and configs. A path into
    // website/ or docs/ is written relative ("../../../website/lib/invite") or from the root ("website/...").
    const code: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (["node_modules", ".turbo"].includes(entry.name) || entry.name.startsWith("dist")) continue;
        const path = join(dir, entry.name);
        if (entry.isDirectory()) walk(path);
        else if (/\.(ts|tsx|mts|js|mjs)$/.test(entry.name)) code.push(path);
      }
    };
    for (const dir of readdirSync(join(root, "packages"))) walk(join(root, "packages", dir));
    walk(join(root, "extension"));
    const named = code.flatMap((file) =>
      [...readFileSync(file, "utf8").matchAll(/(?:\.\.\/)+((?:website|docs)\/[^"'`\s)]*)|["'`]((?:website|docs)\/[^"'`\s)]*)/g)].map((m) => ({ file, path: m[1] ?? m[2] })),
    );
    expect(named.map((n) => n.path)).toEqual(expect.arrayContaining(["website/lib/invite", "website/public/oauth/client-metadata.json"]));
    for (const { file, path } of named) {
      // An import names a module without its extension.
      const real = [path, ...[".ts", ".tsx", ".mjs", ".js"].map((ext) => path + ext)].find((p) => { try { statSync(join(root, p)); return true; } catch { return false; } });
      const covered = real !== undefined && (statSync(join(root, real)).isDirectory() ? covers(PACKAGES_READ_FROM_SITE, `${real}/any`) : covers(PACKAGES_READ_FROM_SITE, real));
      expect(covered, `${file.slice(root.length + 1)} names ${path}`).toBe(true);
    }
  });
});

describe("plan", () => {
  const ready = { draft: false };
  const draft = { draft: true };

  it("an app change skips the website and runs the Desktop jobs", () => {
    expect(plan(["src/components/ChatRow.tsx", "packages/browser/src/engine.ts"], ready)).toMatchObject({ rust: true, website: false, app: true });
  });

  it("a site change runs the website and skips the Desktop jobs", () => {
    expect(plan(["website/app/page.tsx", "website/e2e/bubbles.spec.ts"], ready)).toMatchObject({ website: true, app: false });
    expect(plan(["docs/wisps/101-webrtc.md"], ready)).toMatchObject({ website: true, app: false });
  });

  it("a document the site does not publish runs neither", () => {
    expect(plan(["docs/TESTING.md"], ready)).toMatchObject({ website: false, app: false });
  });

  it("an app file the site copies or quotes runs both", () => {
    expect(plan(["src/components/deck/Deck.tsx"], ready)).toMatchObject({ website: true, app: true });
    expect(plan(["packages/core/src/invite.ts"], ready)).toMatchObject({ website: true, app: true });
  });

  it("the workflow runs everything, even in a draft", () => {
    expect(plan([".github/workflows/ci.yml"], draft)).toMatchObject({ rust: true, website: true, app: true, packages: true });
  });

  it("only a draft skips the Rust jobs", () => {
    expect(plan(["src/App.tsx"], draft).rust).toBe(false);
    expect(plan(["src/App.tsx"], ready).rust).toBe(true);
    expect(plan(["src-tauri/src/lib.rs"], draft).rust).toBe(true);
    expect(plan(["Cargo.lock"], draft).rust).toBe(true);
  });

  it("only docs/ and the site's own files skip the packages' tests", () => {
    expect(plan(["docs/TESTING.md", "docs/wisps/101-webrtc.md"], ready).packages).toBe(false);
    expect(plan(["website/app/page.tsx"], ready).packages).toBe(false);
    expect(plan(["website/lib/invite.ts"], ready).packages).toBe(true);
    expect(plan(["website/public/oauth/client-metadata.json"], ready).packages).toBe(true);
    expect(plan(["docs/TESTING.md", "e2e/support/avatar-fixtures/avatar-extended.webp"], ready).packages).toBe(true);
    expect(plan(["README.md"], draft).packages).toBe(true);
  });

  it("the Desktop workflow is not the site", () => {
    expect(plan([".github/workflows/desktop-macos.yml"], ready)).toMatchObject({ website: false, app: true });
  });
});
