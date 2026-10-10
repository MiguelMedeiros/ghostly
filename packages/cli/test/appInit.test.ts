import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { readAppBundle } from "@ghostly/core";
import { error, ghostly, ok } from "./support/cli";
// covers: apps.bundle

/*
 * `app init` (WISP 1200, Apps · Publishing): the folder it writes is one `app publish` signs as it is and `app verify`
 * accepts, its page type checks against `@ghostlytools/sdk/app`, and it never writes over a file without `--force`.
 */

const tmp = () => mkdtempSync(join(tmpdir(), "ghostly-app-init-"));
const TEMPLATE = ["README.md", "ghostly-app.json", "index.html"];

describe("app init", () => {
  it("writes an app that app publish signs and app verify accepts", async () => {
    const root = tmp();
    const dir = join(root, "demo");
    const made = ok(await ghostly(["app", "init", dir]));
    expect(made).toMatchObject({ dir, name: "demo", title: "Demo", files: ["ghostly-app.json", "index.html", "README.md"] });
    expect(readdirSync(dir).sort()).toEqual(TEMPLATE);
    const source = JSON.parse(readFileSync(join(dir, "ghostly-app.json"), "utf8")) as Record<string, unknown>;
    expect(source).toMatchObject({ name: "demo", title: "Demo", view: "chat", entry: "index.html", permissions: ["chat"] });
    // What publish writes itself is left out.
    for (const key of ["publisher", "sequence", "files"]) expect(source).not.toHaveProperty(key);

    const published = ok(await ghostly(["app", "publish", dir, "--key", join(root, "publisher.key")]));
    expect(published).toMatchObject({ name: "demo", sequence: 1, files: ["README.md", "index.html"], keyCreated: true });
    const verified = ok(await ghostly(["app", "verify", join(dir, "app.ghostlyapp")]));
    expect(verified).toMatchObject({ valid: true, ref: published.ref, digest: published.digest, name: "demo", title: "Demo" });
    const read = readAppBundle(new Uint8Array(readFileSync(join(dir, "app.ghostlyapp"))));
    if (!read.ok) throw new Error(read.reason);
    expect(new TextDecoder().decode(read.bundle.files.get("index.html"))).toBe(readFileSync(join(dir, "index.html"), "utf8"));
  });

  it("takes the name and the title given, and puts the title in the page as text", async () => {
    const dir = join(tmp(), "Some Folder");
    const title = `Tic <b>&</b> "Toe"`;
    ok(await ghostly(["app", "init", dir, "--name", "tic-tac-toe", "--title", title]));
    expect(JSON.parse(readFileSync(join(dir, "ghostly-app.json"), "utf8"))).toMatchObject({ name: "tic-tac-toe", title });
    const page = readFileSync(join(dir, "index.html"), "utf8");
    expect(page).toContain("<title>Tic &lt;b&gt;&amp;&lt;/b&gt; &quot;Toe&quot;</title>");
    expect(page).not.toContain("<b>&</b>");
    ok(await ghostly(["app", "publish", dir, "--key", join(tmp(), "publisher.key")]));
  });

  it("names the app after the folder", async () => {
    const dir = join(tmp(), "My Game_2");
    expect(ok(await ghostly(["app", "init", dir]))).toMatchObject({ name: "my-game-2", title: "My game 2" });
  });

  it("writes nothing over a file that is there, unless --force", async () => {
    const dir = tmp();
    writeFileSync(join(dir, "index.html"), "mine");
    writeFileSync(join(dir, "notes.txt"), "kept");
    const refused = error(await ghostly(["app", "init", dir, "--name", "demo"]), "refused", 1) as { message: string; details?: { reason: string; files: string[] } };
    expect(refused.details).toEqual({ reason: "exists", files: ["index.html"] });
    expect(readFileSync(join(dir, "index.html"), "utf8")).toBe("mine");
    expect(readdirSync(dir).sort()).toEqual(["index.html", "notes.txt"]);

    expect(ok(await ghostly(["app", "init", dir, "--name", "demo", "--force"]))).toMatchObject({ replaced: ["index.html"] });
    expect(readFileSync(join(dir, "index.html"), "utf8")).toContain("<title>Demo</title>");
    expect(readFileSync(join(dir, "notes.txt"), "utf8")).toBe("kept");
    expect(readdirSync(dir).sort()).toEqual([...TEMPLATE, "notes.txt"]);
  });

  it("refuses a name or a title no manifest takes, and writes nothing", async () => {
    const root = tmp();
    expect(error(await ghostly(["app", "init", join(root, "a"), "--name", "Bad Name"]), "usage", 2).message).toContain("--name");
    expect(error(await ghostly(["app", "init", join(root, "b"), "--title", "x".repeat(41)]), "usage", 2).message).toContain("--title");
    // A folder whose name has no letter to start an app's name with.
    expect(error(await ghostly(["app", "init", join(root, "123")]), "usage", 2).message).toContain("--name");
    expect(readdirSync(root)).toEqual([]);
    mkdirSync(join(root, "c"));
    writeFileSync(join(root, "c", "file"), "");
    expect(error(await ghostly(["app", "init", join(root, "c", "file"), "--name", "demo"]), "bad_request", 1).message).toContain("is a file");
    expect(existsSync(join(root, "c", "file", "index.html"))).toBe(false);
  });

  it("writes a page whose script type checks against @ghostlytools/sdk/app", async () => {
    const dir = join(tmp(), "demo");
    ok(await ghostly(["app", "init", dir]));
    const page = readFileSync(join(dir, "index.html"), "utf8");
    const script = /<script type="module">\n([\s\S]*?)<\/script>/.exec(page)?.[1];
    expect(script).toContain(`import("@ghostlytools/sdk/app").MiniAppApi`);
    const file = join(dir, "page.js");
    writeFileSync(file, script!);
    const program = ts.createProgram([file], {
      // As the page runs it: `<script type="module">` has a scope of its own.
      moduleDetection: ts.ModuleDetectionKind.Force,
      allowJs: true, checkJs: true, noEmit: true, strict: true, skipLibCheck: true, target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler, lib: ["lib.es2022.d.ts", "lib.dom.d.ts"], types: [],
      paths: { "@ghostlytools/sdk/app": [resolve(import.meta.dirname, "../../sdk/src/app.ts")] },
    });
    const problems = ts.getPreEmitDiagnostics(program).map((d) => ts.flattenDiagnosticMessageText(d.messageText, "\n"));
    expect(problems).toEqual([]);
  });
});
