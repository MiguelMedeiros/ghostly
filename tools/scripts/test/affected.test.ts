import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { codeFiles as repoCode, knownFiles, workspacePackages } from "../affected/files.mjs";
import { bundleReaches, checkPaths, featureGrep, globToRegExp, packageImports, plan, specsImporting, testsReaching, throughCoreBarrel, UNIT_PROJECTS, workspaceExports } from "../affected/select.mjs";

// A small repository: a few features, a paths map, specs tagged with them, and core modules behind a barrel.
const inventory = {
  features: [
    { id: "app.home" },
    { id: "payments.chat.send" },
    { id: "payments.chat.request" },
    { id: "payments.cashu.melt" },
    { id: "groups.create" },
    { id: "proofs.ssh.verify" },
    { id: "calls.video" },
  ],
  paths: {
    "apps/ui/src/components/PaymentComposer.tsx": ["payments.chat.*"],
    "apps/ui/src/components/Group*.tsx": ["groups.*"],
    "apps/ui/src/App.tsx": ["*"],
    "packages/core/src/sshsig.ts": ["proofs.ssh.*"],
    "packages/core/src/index.ts": ["*"],
    "apps/ui/src/components/CallOverlay.tsx": ["calls.video"],
    "{docs/**,**/*.md}": [],
    "apps/desktop/**": [],
  },
};

const e2eFiles: Record<string, string> = {
  "e2e/support/paired.ts": `import { test } from "./fixtures";\nexport const pair = 1;`,
  "e2e/support/fixtures.ts": `export const test = 1;`,
  "e2e/support/mint.ts": `export const mint = 1;`,
  "e2e/web/chat-payments.spec.ts": `import { pair } from "../support/paired";\ntest("pays", { tag: ["@feature:payments.chat.send", "@feature:payments.chat.request"] }, () => {});`,
  "e2e/web/wallet-cashu.spec.ts": `import { mint } from "../support/mint";\ntest.describe("cashu", { tag: "@feature:payments.cashu.melt" }, () => {});`,
  "e2e/web/groups.spec.ts": `import { pair } from "../support/paired.ts";\ntest("g", { tag: ["@feature:groups.create"] }, () => {});`,
  "e2e/web/home.spec.ts": `test("h", { tag: ["@feature:app.home"] }, () => {});`,
  "e2e/extension/ssh.spec.ts": `test("s", { tag: ["@feature:proofs.ssh.verify", "@client:extension"] }, () => {});`,
  "e2e/desktop/smoke.spec.ts": `test("d", { tag: ["@feature:app.home"] }, () => {});`,
  "e2e/matrix/matrix.spec.ts": `import { pair } from "../support/paired";
test("m", { tag: ["@feature:payments.chat.send"] }, () => {});`,
};

const changed = (...paths: string[]) => paths.map((p) => ({ path: p, exists: !p.startsWith("-") })).map((c) => ({ ...c, path: c.path.replace(/^-/, "") }));
const byName = <T extends { name: string }>(xs: T[]) => Object.fromEntries(xs.map((x) => [x.name, x]));

describe("globs", () => {
  it("reads *, ** and {a,b}", () => {
    expect(globToRegExp("src/*.ts").test("src/a.ts")).toBe(true);
    expect(globToRegExp("src/*.ts").test("src/x/a.ts")).toBe(false);
    expect(globToRegExp("src/**/*.ts").test("src/a.ts")).toBe(true);
    expect(globToRegExp("src/**/*.ts").test("src/x/y/a.ts")).toBe(true);
    expect(globToRegExp("src/**").test("src/x/y/a.ts")).toBe(true);
    expect(globToRegExp("src/*Wallet*.tsx").test("src/ArkWalletPanel.tsx")).toBe(true);
    expect(globToRegExp("{docs/**,**/*.md}").test("docs/TESTING.md")).toBe(true);
    expect(globToRegExp("{docs/**,**/*.md}").test("e2e/README.md")).toBe(true);
    expect(globToRegExp("{docs/**,**/*.md}").test("e2e/README.mdx")).toBe(false);
    expect(globToRegExp("a.b").test("axb")).toBe(false);
  });

  it("builds a --grep that matches a feature tag and not a longer id", () => {
    const re = new RegExp(featureGrep(["payments.chat.send"]));
    expect(re.test("pays @feature:payments.chat.send @gated")).toBe(true);
    expect(re.test("pays @feature:payments.chat.send")).toBe(true);
    expect(re.test("pays @feature:payments.chat.send-all")).toBe(false);
    expect(re.test("pays @feature:payments.chat.sender")).toBe(false);
    expect(re.test("pays @feature:payments.chat.send.x")).toBe(false);
  });
});

describe("a UI-only change", () => {
  const p = plan({ changed: changed("apps/ui/src/components/PaymentComposer.tsx"), inventory, e2eFiles });

  it("runs vitest related where the UI is imported, and nowhere else", () => {
    const unit = byName(p.unit);
    expect(unit.ui.mode).toBe("related");
    expect(unit.ui.files).toEqual(["apps/ui/src/components/PaymentComposer.tsx"]);
    expect(unit.extension.mode).toBe("related");
    for (const name of ["core", "browser", "sdk", "matrix", "scripts"]) expect(unit[name].mode).toBe("skip");
  });

  it("lints the file and typechecks what compiles apps/ui/src/, not the packages under it", () => {
    expect(p.lint).toMatchObject({ mode: "files", files: ["apps/ui/src/components/PaymentComposer.tsx"] });
    const tc = byName(p.typecheck);
    for (const name of ["ui (root tsconfig)", "extension", "extension tests", "web"]) expect(tc[name].mode).toBe("run");
    for (const name of ["core", "browser", "sdk", "e2e"]) expect(tc[name].mode).toBe("skip");
    expect(p.rust.every((r) => r.mode === "skip")).toBe(true);
  });

  it("runs the e2e tests tagged with the features the paths map names", () => {
    expect(p.e2e.mode).toBe("select");
    expect(p.e2e.features).toEqual(["payments.chat.request", "payments.chat.send"]);
    expect(p.e2e.taggedSpecs).toEqual(["e2e/web/chat-payments.spec.ts"]);
    expect(p.e2e.wholeSpecs).toEqual([]);
    expect(new RegExp(p.e2e.grep!).test("x @feature:payments.chat.send")).toBe(true);
    expect(new RegExp(p.e2e.grep!).test("x @feature:payments.cashu.melt")).toBe(false);
  });
});

describe("a core change", () => {
  const codeFiles: Record<string, string> = {
    "packages/core/src/index.ts": `export * from "./bytes";\nexport * from "./sshsig";\nexport * from "./groupSession";\nexport { DhtDelivery, type DeliveryMode } from "./dhtDelivery";`,
    "packages/core/src/bytes.ts": `export function hex() {}\nexport const B = 1;`,
    "packages/core/src/sshsig.ts": `import { hex } from "./bytes";\nexport function verifySshSig() {}\nexport type SshSig = {};`,
    "packages/core/src/groupSession.ts": `import { verifySshSig } from "./sshsig";\nexport class GroupSession {}`,
    "packages/core/src/dhtDelivery.ts": `export class DhtDelivery {}\nexport type DeliveryMode = "a";`,
    "packages/core/test/sshsig.test.ts": `import { verifySshSig } from "../src/sshsig";`,
    "packages/core/test/barrel.test.ts": `import {\n  GroupSession,\n  hex,\n} from "../src";`,
    "packages/core/test/bytes.test.ts": `import { hex } from "../src/bytes";`,
    "packages/browser/src/proofs/ssh.ts": `import { verifySshSig, hex } from "@ghostly/core";`,
    "packages/browser/src/engine/groups.ts": `import { GroupSession as S } from '@ghostly/core';`,
    "packages/browser/src/shared/types.ts": `import type { GroupSession } from "@ghostly/core";\nexport type T = import("@ghostly/core").SshSig;`,
    "packages/browser/src/engine/dht.ts": `import { DhtDelivery, type SshSig } from "@ghostly/core";`,
    "packages/browser/src/platform/crypto.ts": `import * as core from "@ghostly/core";`,
    "packages/browser/test/paymentMock.test.ts": `const { X } = await import("@ghostly/core");`,
    "packages/browser/test/typesOnly.test.ts": `type C = typeof import("@ghostly/core");`,
    "packages/sdk/src/core.ts": `export * from "@ghostly/core";`,
    "apps/ui/src/components/GroupMembersDialog.tsx": `import { GroupSession } from "@ghostly/core";`,
  };

  it("follows the barrel to the importers of the changed module's names, and core modules importing it", () => {
    expect(throughCoreBarrel(["packages/core/src/sshsig.ts"], codeFiles)).toEqual([
      "apps/ui/src/components/GroupMembersDialog.tsx",
      "packages/browser/src/engine/groups.ts", // GroupSession: groupSession.ts imports sshsig.ts
      "packages/browser/src/platform/crypto.ts", // import * as core
      "packages/browser/src/proofs/ssh.ts",
      "packages/browser/test/paymentMock.test.ts", // await import(): may use anything
      "packages/core/test/barrel.test.ts", // GroupSession through "../src"
      "packages/core/test/sshsig.test.ts",
      "packages/sdk/src/core.ts", // export *
    ]);
  });

  it("leaves out type-only importers and importers of other modules", () => {
    const got = throughCoreBarrel(["packages/core/src/dhtDelivery.ts"], codeFiles);
    expect(got).toContain("packages/browser/src/engine/dht.ts");
    expect(got).not.toContain("packages/browser/src/shared/types.ts");
    expect(got).not.toContain("packages/browser/test/typesOnly.test.ts");
    expect(got).not.toContain("packages/browser/src/proofs/ssh.ts");
  });

  it("follows an import of a core subpath (@ghostly/core/miniApp) to that module only", () => {
    const files = {
      "packages/core/src/miniApp.ts": `export const MINI_APP_LIMITS = {};`,
      "packages/core/src/index.ts": `export * from "./sshsig";`,
      "apps/mini/chess/test/mockBroker.ts": `import { MINI_APP_LIMITS, type MiniAppApi } from "@ghostly/core/miniApp";`,
      "apps/mini/chess/src/game.ts": `import type { MiniAppApi } from "@ghostly/core/miniApp";`,
      "apps/mini/chess/src/other.ts": `import { x } from "@ghostly/core/other";`,
    };
    expect(throughCoreBarrel(["packages/core/src/miniApp.ts"], files)).toEqual(["apps/mini/chess/test/mockBroker.ts"]);
  });

  it("hands each project the importers under it instead of the core module", () => {
    const p = plan({ changed: changed("packages/core/src/sshsig.ts"), inventory, e2eFiles, codeFiles });
    const unit = byName(p.unit);
    expect(unit.core.files).toEqual(["packages/core/test/barrel.test.ts", "packages/core/test/sshsig.test.ts"]);
    expect(unit.browser.files).toEqual(["packages/browser/src/engine/groups.ts", "packages/browser/src/platform/crypto.ts", "packages/browser/src/proofs/ssh.ts", "packages/browser/test/paymentMock.test.ts"]);
    expect(unit.ui.files).toContain("apps/ui/src/components/GroupMembersDialog.tsx");
    expect(unit.sdk.files).toContain("packages/sdk/src/core.ts");
    expect(Object.values(unit).flatMap((u) => u.files ?? [])).not.toContain("packages/core/src/sshsig.ts");
    // Every package that imports core is typechecked: an API change breaks the importers, not core.
    expect(p.typecheck.every((t) => t.mode === "run")).toBe(true);
    expect(p.e2e).toMatchObject({ mode: "select", features: ["proofs.ssh.verify"], taggedSpecs: ["e2e/extension/ssh.spec.ts"] });
  });

  it("without the sources it passes the core module to vitest as it is", () => {
    const p = plan({ changed: changed("packages/core/src/sshsig.ts"), inventory, e2eFiles });
    expect(byName(p.unit).browser.files).toEqual(["packages/core/src/sshsig.ts"]);
  });
});

describe("tests that import across workspaces", () => {
  // packages/browser/test/chatConnection.test.ts imports the app's component by relative path: apps/ui/src/ is not among
  // the browser project's sources, so a change to it used to skip these tests (CI caught the break in #287).
  const codeFiles: Record<string, string> = {
    "apps/ui/src/components/ChatConnection.tsx": `import { useI18n } from "../contexts/I18nContext";\nimport { icon } from "./icons/index.js";`,
    "apps/ui/src/components/icons/index.ts": `export const icon = 1;`,
    "apps/ui/src/contexts/I18nContext.tsx": `import en from "../i18n/en.json";`,
    "apps/ui/src/components/Other.tsx": `export const other = 1;`,
    "packages/browser/test/chatConnection.test.ts": `import { ChatConnection } from "../../../apps/ui/src/components/ChatConnection";\nimport { I18nProvider } from "../../../apps/ui/src/contexts/I18nContext";`,
    "packages/browser/test/storage.test.ts": `import { save } from "../../../apps/ui/src/lib/storage";`,
    "packages/browser/test/helpers/fake.ts": `export const fake = 1;`,
    "e2e/matrix/blocks.ts": `import { fake } from "../../packages/browser/test/helpers/fake";`,
    "e2e/matrix/table.test.ts": `import { rows } from "./matrix";`,
    "e2e/matrix/rails.test.ts": `import { blocks } from "./blocks.ts";`,
  };

  it("a change to apps/ui/src/components/ChatConnection.tsx runs packages/browser/test/chatConnection.test.ts", () => {
    const p = plan({ changed: changed("apps/ui/src/components/ChatConnection.tsx"), inventory, e2eFiles, codeFiles });
    const unit = byName(p.unit);
    expect(unit.browser).toMatchObject({ mode: "related", files: ["packages/browser/test/chatConnection.test.ts"] });
    expect(unit.browser.reason).toContain("1 test file(s) importing the change by relative path");
    // Projects whose sources hold apps/ui/src/ still get the changed file itself.
    expect(unit.ui.files).toEqual(["apps/ui/src/components/ChatConnection.tsx"]);
    expect(unit.core.mode).toBe("skip");
    expect(unit.matrix.mode).toBe("skip");
  });

  it("follows the imports through other files, index files, .js specifiers and non-code files", () => {
    for (const file of ["apps/ui/src/contexts/I18nContext.tsx", "apps/ui/src/components/icons/index.ts", "apps/ui/src/i18n/en.json", "-apps/ui/src/components/icons/index.ts"]) {
      const p = plan({ changed: changed(file), inventory, e2eFiles, codeFiles });
      expect(byName(p.unit).browser.files, file).toEqual(["packages/browser/test/chatConnection.test.ts"]);
    }
    expect(byName(plan({ changed: changed("apps/ui/src/components/Other.tsx"), inventory, e2eFiles, codeFiles }).unit).browser.mode).toBe("skip");
  });

  it("reaches another project's tests through its helpers", () => {
    const p = plan({ changed: changed("packages/browser/test/helpers/fake.ts"), inventory, e2eFiles, codeFiles });
    expect(byName(p.unit).matrix.files).toEqual(["e2e/matrix/rails.test.ts"]);
  });

  it("a file renamed or deleted inside a project's sources runs the tests that still import the old path", () => {
    // test-affected.mjs diffs with --no-renames: a rename is the old path (deleted) and the new one. vitest is given
    // only files that exist, so the tests importing the old path were never selected and failed first in the batch.
    const files: Record<string, string> = {
      "tools/scripts/tarball.mjs": `export function tarGz() {}`,
      "tools/scripts/prepare-translation-runtime.mjs": `import { tarGz } from "./tarball.mjs";`,
      "tools/scripts/test/tarGz.test.ts": `import { tarGz } from "../tar-gz.mjs";`,
      "tools/scripts/test/translationRuntime.test.ts": `import { tarGz } from "../tar-gz.mjs";\nimport "../prepare-translation-runtime.mjs";`,
      "tools/scripts/test/other.test.ts": `import { x } from "../other.mjs";`,
    };
    const rename = changed("-tools/scripts/tar-gz.mjs", "tools/scripts/tarball.mjs", "tools/scripts/prepare-translation-runtime.mjs");
    const scripts = byName(plan({ changed: rename, inventory, e2eFiles, codeFiles: files }).unit).scripts;
    expect(scripts.mode).toBe("related");
    expect(scripts.files).toEqual([
      "tools/scripts/tarball.mjs", "tools/scripts/prepare-translation-runtime.mjs",
      "tools/scripts/test/tarGz.test.ts", "tools/scripts/test/translationRuntime.test.ts",
    ]);
    // A delete alone, too.
    expect(byName(plan({ changed: changed("-tools/scripts/tar-gz.mjs"), inventory, e2eFiles, codeFiles: files }).unit).scripts.files)
      .toEqual(["tools/scripts/test/tarGz.test.ts", "tools/scripts/test/translationRuntime.test.ts"]);
  });

  it("keeps to the test files the project runs", () => {
    expect(testsReaching(["packages/browser/test/helpers/fake.ts"], codeFiles, ["packages/browser/test/**"])).toEqual([]);
    expect(testsReaching(["apps/ui/src/components/ChatConnection.tsx"], codeFiles, ["e2e/matrix/*"])).toEqual([]);
  });

  it("finds the real chatConnection test from the real component", () => {
    const root = join(import.meta.dirname, "..", "..", "..");
    const real = Object.fromEntries(["packages/browser/test/chatConnection.test.ts", "apps/ui/src/components/ChatConnection.tsx"].map((f) => [f, readFileSync(join(root, f), "utf8")]));
    expect(testsReaching(["apps/ui/src/components/ChatConnection.tsx"], real, ["packages/browser/test/**"])).toEqual(["packages/browser/test/chatConnection.test.ts"]);
  });
});

describe("the CLI", () => {
  // Most CLI tests run the built binary (test/support/cli.ts spawns dist/ghostly.mjs), so no import links them to
  // what it is built from: packages/cli/src and the parts of @ghostly/browser and @ghostly/core it bundles.
  const codeFiles: Record<string, string> = {
    "packages/cli/src/bin.ts": `import { run } from "./main";`,
    "packages/cli/src/main.ts": `import { chats } from "./commands";\nimport { startEngine } from "@ghostly/browser/engine/node";\nimport { hex } from "@ghostly/core";`,
    "packages/cli/src/commands/index.ts": `export const chats = 1;`,
    "packages/cli/src/args.ts": `export const parse = 1;`,
    "packages/cli/test/args.test.ts": `import { parse } from "../src/args";`,
    "packages/cli/test/support/cli.ts": `export const BIN = "dist/ghostly.mjs";`,
    "packages/cli/test/daemon.test.ts": `import { ghostly } from "./support/cli";`,
    "packages/browser/src/engine/node.ts": `import { community } from "./community.ts";`,
    "packages/browser/src/engine/community.ts": `export const community = 1;`,
    "packages/browser/src/components/Picker.tsx": `export const Picker = 1;`,
    "packages/core/src/index.ts": `export * from "./bytes";`,
    "packages/core/src/bytes.ts": `export function hex() {}`,
  };
  const RUNNER = "packages/cli/test/support/cli.ts";
  const cli = (files: string[], sources: Record<string, string> | undefined = codeFiles) =>
    byName(plan({ changed: changed(...files), inventory, e2eFiles, codeFiles: sources }).unit).cli;

  it("reads what the binary is built from, through relative imports and workspace packages", () => {
    expect([...bundleReaches("packages/cli/src/bin.ts", codeFiles)].sort()).toEqual([
      "packages/browser/src/engine/community",
      "packages/browser/src/engine/node",
      "packages/cli/src/bin",
      "packages/cli/src/commands/index",
      "packages/cli/src/main",
      "packages/core/src/bytes",
      "packages/core/src/index",
    ]);
  });

  it("a change under packages/cli runs the tests that import it, and the binary's when the binary takes it in", () => {
    expect(cli(["packages/cli/src/commands/index.ts"])).toMatchObject({ mode: "related", files: ["packages/cli/src/commands/index.ts", RUNNER] });
    expect(cli(["packages/cli/src/args.ts"])).toMatchObject({ mode: "related", files: ["packages/cli/src/args.ts"] });
    expect(cli(["-packages/cli/src/commands/index.ts"]).files).toContain(RUNNER);
    expect(cli(["packages/cli/test/args.test.ts"])).toMatchObject({ mode: "related", files: ["packages/cli/test/args.test.ts"] });
  });

  it("a browser or core change the binary bundles runs the binary's tests too", () => {
    expect(cli(["packages/browser/src/engine/community.ts"])).toMatchObject({ mode: "related", files: ["packages/browser/src/engine/community.ts", RUNNER] });
    expect(cli(["packages/browser/src/engine/community.ts"]).reason).toContain("the built CLI");
    expect(cli(["packages/core/src/bytes.ts"]).files).toContain(RUNNER);
    expect(cli(["packages/browser/src/components/Picker.tsx"]).files).not.toContain(RUNNER);
    expect(cli(["apps/ui/src/components/Other.tsx"]).mode).toBe("skip");
  });

  it("without the sources, a change under what the binary can bundle runs its tests", () => {
    expect(cli(["packages/browser/src/engine/community.ts"], undefined).files).toEqual(["packages/browser/src/engine/community.ts", RUNNER]);
  });

  it("its configs and the build before its tests run it whole", () => {
    for (const file of ["packages/cli/vitest.config.ts", "packages/cli/vite.config.ts", "packages/cli/test/support/build.ts", "packages/cli/package.json"]) {
      expect(cli([file]).mode, file).toBe("whole");
    }
  });

  it("matches the real package: its globalSetup runs it whole, and the runner and entry are where it says", () => {
    const root = join(import.meta.dirname, "..", "..", "..");
    const project = UNIT_PROJECTS.find((p) => p.name === "cli")!;
    const config = readFileSync(join(root, "packages/cli/vitest.config.ts"), "utf8");
    const setups = [...config.matchAll(/globalSetup:\s*\[([^\]]*)\]/g)].flatMap((m) => [...m[1].matchAll(/["']([^"']+)["']/g)].map((s) => `packages/cli/${s[1]}`));
    expect(setups.length).toBeGreaterThan(0);
    for (const setup of setups) expect(project.whole).toContain(setup);
    expect(readFileSync(join(root, project.bundle!.runner), "utf8")).toContain("dist/ghostly.mjs");
    expect(readFileSync(join(root, "packages/cli/vite.config.ts"), "utf8")).toContain(`ssr: "${project.bundle!.entry.replace("packages/cli/", "")}"`);
  });
});

describe("imports by package name", () => {
  // packages/browser/test/irohWeb.test.ts loads the committed wasm through `import("@ghostly/iroh-web")`: no relative
  // path leads there, so a rebuilt packages/iroh-web/pkg used to run no browser test.
  const packages = workspaceExports({
    "packages/iroh-web/package.json": JSON.stringify({ name: "@ghostly/iroh-web", exports: { ".": "./pkg/ghostly_iroh_web.js", "./wasm": "./pkg/ghostly_iroh_web_bg.wasm" } }),
    "packages/browser/package.json": JSON.stringify({ name: "@ghostly/browser", exports: { "./*": "./src/*.ts" } }),
    "packages/core/package.json": JSON.stringify({ name: "@ghostly/core", exports: { ".": "./src/index.ts", "./miniApp": "./src/miniApp.ts" } }),
    "packages/sdk/package.json": JSON.stringify({ name: "@ghostlytools/sdk", exports: { ".": { types: "./dist/index.d.ts", default: "./dist/index.js" } } }),
    "infra/relay/package.json": JSON.stringify({ name: "relay", main: "relay.mjs" }),
    "apps/web/package.json": JSON.stringify({ name: "@ghostly/web", private: true }),
  });
  const codeFiles: Record<string, string> = {
    "packages/iroh-web/pkg/ghostly_iroh_web.js": `export function initSync() {}`,
    "packages/browser/src/platform/irohWeb.ts": `export const load = () => import("@ghostly/iroh-web");`,
    "packages/browser/src/engine/node.ts": `import { load } from "../platform/irohWeb";`,
    "packages/browser/test/irohWeb.test.ts": `const m = await import("@ghostly/iroh-web");\nconst wasm = createRequire(import.meta.url).resolve("@ghostly/iroh-web/wasm");`,
    "packages/browser/test/engine.test.ts": `import { start } from "../src/engine/node";`,
    "packages/browser/test/other.test.ts": `import { x } from "@ghostly/other";`,
    "packages/core/src/index.ts": `export * from "./bytes";`,
    "packages/core/src/bytes.ts": `export const hex = 1;`,
    "e2e/matrix/bytes.test.ts": `import { hex } from "@ghostly/core";`,
    "e2e/matrix/node.test.ts": `import { start } from "@ghostly/browser/engine/node";`,
  };

  it("reads each workspace's exports, conditions and main", () => {
    expect(packages).toEqual({
      "@ghostly/iroh-web": [[".", "packages/iroh-web/pkg/ghostly_iroh_web.js"], ["./wasm", "packages/iroh-web/pkg/ghostly_iroh_web_bg.wasm"]],
      "@ghostly/browser": [["./*", "packages/browser/src/*.ts"]],
      "@ghostly/core": [[".", "packages/core/src/index.ts"], ["./miniApp", "packages/core/src/miniApp.ts"]],
      "@ghostlytools/sdk": [[".", "packages/sdk/dist/index.js"]],
      relay: [[".", "infra/relay/relay.mjs"]],
    });
    expect(packageImports(codeFiles["packages/browser/test/irohWeb.test.ts"], packages)).toEqual(["packages/iroh-web/pkg/ghostly_iroh_web", "packages/iroh-web/pkg/ghostly_iroh_web_bg.wasm"]);
    expect(packageImports(`import "@ghostly/browser/engine/node.ts";\nimport x from "@ghostly/core/miniApp";\nimport y from "@ghostly/core/nope";\nimport z from "react";`, packages)).toEqual(["packages/browser/src/engine/node", "packages/core/src/miniApp"]);
  });

  it("a rebuilt packages/iroh-web/pkg runs the browser tests that load it, directly or through the engine", () => {
    const browser = (file: string) => byName(plan({ changed: changed(file), inventory, e2eFiles, codeFiles, packages }).unit).browser;
    expect(browser("packages/iroh-web/pkg/ghostly_iroh_web.js")).toMatchObject({ mode: "related", files: ["packages/browser/test/engine.test.ts", "packages/browser/test/irohWeb.test.ts"] });
    expect(browser("packages/iroh-web/pkg/ghostly_iroh_web_bg.wasm")).toMatchObject({ mode: "related", files: ["packages/browser/test/irohWeb.test.ts"] });
  });

  it("follows a subpath into another project's sources, but not @ghostly/core's barrel (throughCoreBarrel reads it)", () => {
    expect(testsReaching(["packages/browser/src/platform/irohWeb.ts"], codeFiles, ["e2e/matrix/*"], packages)).toEqual(["e2e/matrix/node.test.ts"]);
    expect(testsReaching(["packages/core/src/bytes.ts"], codeFiles, ["e2e/matrix/*"], packages)).toEqual([]);
  });

  it("the built CLI takes in what it imports by package name", () => {
    const files = {
      "packages/cli/src/bin.ts": `const iroh = await import("@ghostly/iroh-web");`,
      "packages/iroh-web/pkg/ghostly_iroh_web.js": `export function initSync() {}`,
    };
    expect(bundleReaches("packages/cli/src/bin.ts", files, packages)).toContain("packages/iroh-web/pkg/ghostly_iroh_web");
    expect(byName(plan({ changed: changed("packages/iroh-web/pkg/ghostly_iroh_web.js"), inventory, e2eFiles, codeFiles: files, packages }).unit).cli.files).toEqual(["packages/cli/test/support/cli.ts"]);
  });
});

describe("the real repository's import graph", () => {
  // test-affected.mjs reads it through tools/scripts/affected/files.mjs. It used to read a list of folders, so a chain
  // through native/ or apps/web/'s own files was cut: a change to native/transports/hyperdht/redial.mjs ran 1 of the
  // 8 browser tests that reach it (through endpoint.mjs) and no CLI test, apps/web/appsTestFlag.ts none of the 3 UI
  // tests that reach it (through apps/web/runnerPolicy.ts), and a rebuilt @ghostly/iroh-web no browser test.
  const root = join(import.meta.dirname, "..", "..", "..");
  let real: { codeFiles: Record<string, string>; packages: Record<string, [string, string][]>; e2eFiles: Record<string, string> } | undefined;
  const load = () => {
    if (real) return real;
    const known = knownFiles(root);
    const codeFiles = repoCode(root, known);
    return (real = { codeFiles, packages: workspacePackages(root, known), e2eFiles: Object.fromEntries(Object.entries(codeFiles).filter(([p]) => p.startsWith("e2e/"))) });
  };
  const realPlan = (...files: string[]) => {
    const { codeFiles, packages, e2eFiles } = load();
    const inventory = JSON.parse(readFileSync(join(root, "e2e/features.json"), "utf8"));
    return byName(plan({ changed: changed(...files), inventory, e2eFiles, codeFiles, packages }).unit);
  };

  it("reads every TypeScript/JavaScript file git knows, and the workspaces' package names", () => {
    const { codeFiles, packages } = load();
    for (const file of ["native/transports/hyperdht/endpoint.mjs", "apps/web/runnerPolicy.ts", "infra/services/hyperdht-relay/relay.mjs", "packages/browser/test/irohWeb.test.ts"]) {
      expect(Object.keys(codeFiles), file).toContain(file);
    }
    expect(packages["@ghostly/iroh-web"]).toContainEqual([".", "packages/iroh-web/pkg/ghostly_iroh_web.js"]);
  });

  it("a change behind native/, apps/web/ or @ghostly/iroh-web runs the tests that reach it", { timeout: 30_000 }, () => {
    const unit = realPlan("native/transports/hyperdht/redial.mjs", "packages/iroh-web/pkg/ghostly_iroh_web_bg.wasm", "apps/web/appsTestFlag.ts");
    expect(unit.browser.files).toEqual(expect.arrayContaining([
      "packages/browser/test/hyperdhtRedial.test.ts",
      "packages/browser/test/hyperdhtEndpointBuffered.test.ts",
      "packages/browser/test/hyperdhtEndpointClose.test.ts",
      "packages/browser/test/hyperdhtEndpointEphemeral.test.ts",
      "packages/browser/test/hyperdhtEndpointRedial.test.ts",
      "packages/browser/test/hyperdhtEndpointShared.test.ts",
      "packages/browser/test/hyperdhtRelay.test.ts",
      "packages/browser/test/nativeMigration.test.ts",
      "packages/browser/test/irohWeb.test.ts",
      "packages/browser/test/irohWebRelays.test.ts",
    ]));
    // The built CLI loads endpoint.mjs (src/runtime/engine.ts), and with it redial.mjs.
    expect(unit.cli.files).toContain("packages/cli/test/support/cli.ts");
    expect(unit.ui.files).toEqual(expect.arrayContaining([
      "apps/ui/src/test/apps/runnerCheck.test.ts",
      "apps/ui/src/test/apps/runnerRetry.test.tsx",
      "apps/ui/src/test/security/contentSecurityPolicy.test.ts",
    ]));
  });

  it("a file few tests reach still runs only those", { timeout: 30_000 }, () => {
    // native/ is read now too: one of its files that only a scripts test imports must not pull in anything else.
    const unit = realPlan("native/translation/protocol.mjs");
    const picked = Object.values(unit).flatMap((u) => (u.mode === "whole" ? [`${u.name}: whole`] : u.files ?? []));
    expect(picked).toEqual(["tools/scripts/test/translationRuntime.test.ts"]);
    expect(realPlan("native/transports/hyperdht/redial.mjs").browser.files.length).toBeLessThan(20);
  });
});

describe("fallbacks", () => {
  it("a lockfile or root package.json runs everything", () => {
    for (const file of ["package-lock.json", "package.json", "tools/patches/sodium.patch"]) {
      const p = plan({ changed: changed(file), inventory, e2eFiles });
      expect(p.unit.every((u) => u.mode === "whole")).toBe(true);
      expect(p.lint.mode).toBe("whole");
      expect(p.typecheck.every((t) => t.mode === "run")).toBe(true);
      expect(p.e2e.mode).toBe("whole");
      expect(p.e2e.reasons.join()).toContain(file);
    }
  });

  it('a package.json whose "scripts" alone changed installs nothing new: it is left out', () => {
    const p = plan({ changed: [{ path: "package.json", exists: true, scriptsOnly: true }], inventory, e2eFiles });
    expect(p.scriptsOnly).toEqual(["package.json"]);
    expect(p.unit.every((u) => u.mode === "skip")).toBe(true);
    expect(p.lint.mode).toBe("skip");
    expect(p.e2e.mode).toBe("skip");
  });

  it("core's index.ts runs every project that imports core whole, and every spec", () => {
    const p = plan({ changed: changed("packages/core/src/index.ts"), inventory, e2eFiles, codeFiles: {} });
    const unit = byName(p.unit);
    for (const name of ["core", "browser", "sdk", "extension", "ui", "cli"]) expect(unit[name].mode).toBe("whole");
    for (const name of ["matrix", "scripts"]) expect(unit[name].mode).toBe("skip");
    expect(p.e2e.mode).toBe("whole");
    expect(p.e2e.specs).not.toContain("e2e/desktop/smoke.spec.ts");
  });

  it("a file with no paths entry runs every spec, and says which file", () => {
    const p = plan({ changed: changed("apps/ui/src/components/NewThing.tsx"), inventory, e2eFiles });
    expect(p.e2e.mode).toBe("whole");
    expect(p.e2e.reasons).toEqual([expect.stringContaining("apps/ui/src/components/NewThing.tsx has no entry")]);
  });

  it('a file mapped to "*" runs every spec', () => {
    expect(plan({ changed: changed("apps/ui/src/App.tsx"), inventory, e2eFiles }).e2e.mode).toBe("whole");
  });

  it("a config no import graph sees runs its project whole", () => {
    expect(byName(plan({ changed: changed("apps/ui/vitest.ui.config.ts"), inventory, e2eFiles }).unit).ui.mode).toBe("whole");
    expect(byName(plan({ changed: changed("apps/ui/src/test/setup.ts"), inventory, e2eFiles }).unit).ui.mode).toBe("whole");
    expect(plan({ changed: changed("eslint.config.mjs"), inventory, e2eFiles }).lint.mode).toBe("whole");
    expect(plan({ changed: changed("tsconfig.json"), inventory, e2eFiles }).typecheck.every((t) => t.mode === "run")).toBe(true);
    expect(plan({ changed: changed("e2e/playwright.config.ts"), inventory, e2eFiles }).e2e.mode).toBe("whole");
  });
});

describe("e2e files", () => {
  it("a changed spec runs whole; a deleted one runs nothing", () => {
    const p = plan({ changed: changed("e2e/web/home.spec.ts", "-e2e/web/gone.spec.ts"), inventory, e2eFiles });
    expect(p.e2e).toMatchObject({ mode: "select", wholeSpecs: ["e2e/web/home.spec.ts"], taggedSpecs: [], none: ["e2e/web/gone.spec.ts"] });
  });

  it("a changed helper runs the specs that import it, directly or through another helper", () => {
    expect([...specsImporting("e2e/support/fixtures.ts", e2eFiles)].sort()).toEqual(["e2e/matrix/matrix.spec.ts", "e2e/web/chat-payments.spec.ts", "e2e/web/groups.spec.ts"]);
    const p = plan({ changed: changed("e2e/support/mint.ts"), inventory, e2eFiles });
    expect(p.e2e.wholeSpecs).toEqual(["e2e/web/wallet-cashu.spec.ts"]);
    expect(p.typecheck.find((t) => t.name === "e2e")!.mode).toBe("run");
  });

  it("a file the specs read from disk runs them through the paths map; one with no entry runs nothing", () => {
    const withFixture = { ...inventory, paths: { ...inventory.paths, "e2e/fixtures/wallet/**": ["payments.cashu.*"] } };
    const p = plan({ changed: changed("e2e/fixtures/wallet/mint.json"), inventory: withFixture, e2eFiles });
    expect(p.e2e).toMatchObject({ mode: "select", taggedSpecs: ["e2e/web/wallet-cashu.spec.ts"], none: [] });
    expect(plan({ changed: changed("e2e/fixtures/other/data.json"), inventory: withFixture, e2eFiles }).e2e).toMatchObject({ mode: "skip", none: ["e2e/fixtures/other/data.json"] });
  });

  it("the matrix's specs (a config of their own) are never picked", () => {
    expect(plan({ changed: changed("apps/ui/src/components/PaymentComposer.tsx"), inventory, e2eFiles }).e2e.taggedSpecs).not.toContain("e2e/matrix/matrix.spec.ts");
    expect(plan({ changed: changed("e2e/matrix/matrix.spec.ts"), inventory, e2eFiles }).e2e).toMatchObject({ mode: "skip", none: ["e2e/matrix/matrix.spec.ts"] });
    expect(specsImporting("e2e/support/paired.ts", e2eFiles)).toContain("e2e/matrix/matrix.spec.ts");
    expect(plan({ changed: changed("e2e/support/paired.ts"), inventory, e2eFiles }).e2e.wholeSpecs).toEqual(["e2e/web/chat-payments.spec.ts", "e2e/web/groups.spec.ts"]);
  });

  it("Desktop specs are never picked; a Desktop change leaves a note", () => {
    const p = plan({ changed: changed("e2e/desktop/smoke.spec.ts", "apps/desktop/src/main.rs"), inventory, e2eFiles });
    expect(p.e2e.mode).toBe("skip");
    expect(p.e2e.desktop).toEqual(["e2e/desktop/smoke.spec.ts", "apps/desktop/src/main.rs"]);
  });
});

describe("the rest", () => {
  it("the Android app's Kotlin runs the check of its comments, and nothing else does", () => {
    const mode = (...files: string[]) => byName(plan({ changed: changed(...files), inventory, e2eFiles }).unit)["android kotlin"].mode;
    expect(mode("apps/desktop/gen/android/app/src/main/java/tools/ghostly/app/CameraCapture.kt")).toBe("whole");
    expect(mode("apps/desktop/gen/android/build.gradle.kts")).toBe("whole");
    expect(mode("apps/desktop/gen/android/app/src/main/AndroidManifest.xml")).toBe("skip");
    expect(mode("apps/desktop/src/lib.rs")).toBe("skip");
  });

  it("a file the scripts' tests read from disk runs them, as no import graph shows it", () => {
    const mode = (...files: string[]) => byName(plan({ changed: changed(...files), inventory, e2eFiles }).unit).scripts.mode;
    for (const file of [
      ".github/workflows/e2e.yml",
      ".github/dependabot.yml",
      "apps/web/nginx.conf",
      "apps/web/nginx-services.conf",
      "apps/web/Dockerfile",
      "apps/desktop/tauri.conf.json",
      "e2e/features.json",
      "apps/desktop/gen/android/gradle/wrapper/gradle-wrapper.jar",
      "apps/desktop/gen/android/gradle/wrapper/gradle-wrapper.properties",
    ]) {
      expect(mode(file), file).toBe("whole");
    }
    expect(mode("tools/scripts/ci-changes.mjs")).toBe("related");
  });

  it("a doc, crate or config a scripts test reads from disk runs that test", () => {
    // A draft's tier is all the train waits for: a README link, a RELEASING.md line or an iroh-web source edited
    // without its rebuild went red only in the train's batches.
    const scripts = (...files: string[]) => byName(plan({ changed: changed(...files), inventory, e2eFiles }).unit).scripts;
    const cases: [string, string][] = [
      ["README.md", "readme.test.ts"],
      ["docs/INSTALLATION.md", "readme.test.ts"],
      ["docs/WEB.md", "androidReleased.test.ts"],
      ["docs/ANDROID.md", "androidReleased.test.ts"],
      ["apps/website/content/home.ts", "androidReleased.test.ts"],
      ["docs/RELEASING.md", "chromeWebStore.test.ts"],
      ["docs/RELEASING.md", "npmPublish.test.ts"],
      ["docs/RELEASING.md", "webLatest.test.ts"],
      ["CHANGELOG.md", "bumpVersion.test.ts"],
      ["apps/desktop/src/translate.rs", "translationRuntimes.test.ts"],
      ["e2e/playwright.config.ts", "e2eWorkflow.test.ts"],
      ["native/transports/iroh-web/src/lib.rs", "irohWebBuild.test.ts"],
      ["packages/iroh-web/pkg/ghostly_iroh_web_bg.wasm", "irohWebBuild.test.ts"],
    ];
    for (const [file, test] of cases) {
      const p = scripts(file);
      expect(p.mode, file).toBe("related");
      expect(p.files, file).toContain(`tools/scripts/test/${test}`);
    }
    // Only those: a doc no scripts test reads still runs nothing.
    expect(scripts("docs/TESTING.md").mode).toBe("skip");
  });

  it("every repository file a scripts test reads by name runs that test", () => {
    // `read("x")`, `json("x")`, `readFileSync(join(root, "x"))` and the like, for an existing file outside
    // tools/scripts (vitest related sees those): a new read must come with an entry in the scripts project's `reads`.
    const root = join(import.meta.dirname, "..", "..", "..");
    const dir = join(root, "tools/scripts/test");
    const read = /\b(?:read|json|readFileSync|copyFileSync|cpSync)\(\s*(?:(?:join|resolve)\(\s*root\s*,\s*)?["'`]([^"'`$]+)["'`]/g;
    const missed = new Set<string>();
    for (const name of readdirSync(dir).filter((n) => n.endsWith(".test.ts"))) {
      for (const [, file] of readFileSync(join(dir, name), "utf8").matchAll(read)) {
        if (file.startsWith("tools/scripts/") || !existsSync(join(root, file)) || !statSync(join(root, file)).isFile()) continue;
        const p = byName(plan({ changed: changed(file), inventory, e2eFiles }).unit).scripts;
        if (p.mode !== "whole" && !p.files?.includes(`tools/scripts/test/${name}`)) missed.add(`${name} reads ${file}`);
      }
    }
    expect([...missed]).toEqual([]);
  });

  it("a file whose named paths CI's gates must cover runs the check of them, which reads it from disk", () => {
    // ci-changes.test.ts reads the website's scripts, the packages' code and the crates' Rust for the paths they name:
    // no import graph shows it. A draft's tier is all the train waits for, so a website script naming an uncovered
    // file went red only in the train's batches (2026-11-03, three in a row).
    const mode = (...files: string[]) => byName(plan({ changed: changed(...files), inventory, e2eFiles }).unit)["ci gates"]?.mode;
    for (const file of ["apps/website/scripts/privacy-hosts.test.mjs", "packages/browser/src/proofs/domain.ts", "packages/cli/test/x.test.ts", "apps/extension/src/background.ts", "apps/desktop/src/lib.rs", "native/transports/src/lib.rs"]) {
      expect(mode(file), file).toBe("whole");
    }
    for (const file of ["apps/website/app/privacy/page.tsx", "apps/ui/src/App.tsx", "docs/TESTING.md", "apps/desktop/gen/android/build.gradle.kts"]) expect(mode(file), file).toBe("skip");
  });

  it("Rust runs for the Desktop crates, and Cargo.lock runs it", () => {
    const r = (...files: string[]) => Object.fromEntries(plan({ changed: changed(...files), inventory, e2eFiles }).rust.map((x) => [x.name, x.mode]));
    expect(r("apps/desktop/src/lib.rs")).toEqual({ desktop: "run" });
    expect(r("native/transports/src/lib.rs")).toEqual({ desktop: "run" });
    expect(r("Cargo.lock")).toEqual({ desktop: "run" });
    expect(r("docs/README.md")).toEqual({ desktop: "skip" });
  });

  it("docs run nothing", () => {
    const p = plan({ changed: changed("docs/TESTING.md", "e2e/README.md"), inventory, e2eFiles });
    expect(p.unit.every((u) => u.mode === "skip")).toBe(true);
    expect(p.lint.mode).toBe("skip");
    expect(p.typecheck.every((t) => t.mode === "skip")).toBe(true);
    expect(p.e2e.mode).toBe("skip");
  });

  it("a changed test runs itself", () => {
    const p = plan({ changed: changed("packages/browser/test/nwc.test.ts"), inventory, e2eFiles });
    expect(byName(p.unit).browser).toMatchObject({ mode: "related", files: ["packages/browser/test/nwc.test.ts"] });
    expect(byName(p.unit).core.mode).toBe("skip");
  });

  it("checkPaths flags a pattern no feature matches", () => {
    expect(checkPaths(inventory)).toEqual([]);
    expect(checkPaths({ features: inventory.features, paths: { "src/x.ts": ["payment.*", "groups.create"] } })).toEqual(['paths["src/x.ts"]: "payment.*" matches no feature']);
  });
});

describe("the real inventory", () => {
  const real = JSON.parse(readFileSync(join(import.meta.dirname, "..", "..", "..", "e2e", "features.json"), "utf8"));
  it("has a paths map whose every pattern names a feature", () => {
    expect(Object.keys(real.paths ?? {}).length).toBeGreaterThan(0);
    expect(checkPaths(real)).toEqual([]);
  });
});
