import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { bundleReaches, checkPaths, featureGrep, globToRegExp, plan, specsImporting, testsReaching, throughCoreBarrel, UNIT_PROJECTS } from "../affected/select.mjs";

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
    "src/components/PaymentComposer.tsx": ["payments.chat.*"],
    "src/components/Group*.tsx": ["groups.*"],
    "src/App.tsx": ["*"],
    "packages/core/src/sshsig.ts": ["proofs.ssh.*"],
    "packages/core/src/index.ts": ["*"],
    "src/components/CallOverlay.tsx": ["calls.video"],
    "{docs/**,**/*.md}": [],
    "src-tauri/**": [],
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
  const p = plan({ changed: changed("src/components/PaymentComposer.tsx"), inventory, e2eFiles });

  it("runs vitest related where the UI is imported, and nowhere else", () => {
    const unit = byName(p.unit);
    expect(unit.ui.mode).toBe("related");
    expect(unit.ui.files).toEqual(["src/components/PaymentComposer.tsx"]);
    expect(unit.extension.mode).toBe("related");
    for (const name of ["core", "browser", "sdk", "matrix", "scripts"]) expect(unit[name].mode).toBe("skip");
  });

  it("lints the file and typechecks what compiles src/, not the packages under it", () => {
    expect(p.lint).toMatchObject({ mode: "files", files: ["src/components/PaymentComposer.tsx"] });
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
    "src/components/GroupMembersDialog.tsx": `import { GroupSession } from "@ghostly/core";`,
  };

  it("follows the barrel to the importers of the changed module's names, and core modules importing it", () => {
    expect(throughCoreBarrel(["packages/core/src/sshsig.ts"], codeFiles)).toEqual([
      "packages/browser/src/engine/groups.ts", // GroupSession: groupSession.ts imports sshsig.ts
      "packages/browser/src/platform/crypto.ts", // import * as core
      "packages/browser/src/proofs/ssh.ts",
      "packages/browser/test/paymentMock.test.ts", // await import(): may use anything
      "packages/core/test/barrel.test.ts", // GroupSession through "../src"
      "packages/core/test/sshsig.test.ts",
      "packages/sdk/src/core.ts", // export *
      "src/components/GroupMembersDialog.tsx",
    ]);
  });

  it("leaves out type-only importers and importers of other modules", () => {
    const got = throughCoreBarrel(["packages/core/src/dhtDelivery.ts"], codeFiles);
    expect(got).toContain("packages/browser/src/engine/dht.ts");
    expect(got).not.toContain("packages/browser/src/shared/types.ts");
    expect(got).not.toContain("packages/browser/test/typesOnly.test.ts");
    expect(got).not.toContain("packages/browser/src/proofs/ssh.ts");
  });

  it("hands each project the importers under it instead of the core module", () => {
    const p = plan({ changed: changed("packages/core/src/sshsig.ts"), inventory, e2eFiles, codeFiles });
    const unit = byName(p.unit);
    expect(unit.core.files).toEqual(["packages/core/test/barrel.test.ts", "packages/core/test/sshsig.test.ts"]);
    expect(unit.browser.files).toEqual(["packages/browser/src/engine/groups.ts", "packages/browser/src/platform/crypto.ts", "packages/browser/src/proofs/ssh.ts", "packages/browser/test/paymentMock.test.ts"]);
    expect(unit.ui.files).toContain("src/components/GroupMembersDialog.tsx");
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
  // packages/browser/test/chatConnection.test.ts imports the app's component by relative path: src/ is not among
  // the browser project's sources, so a change to it used to skip these tests (CI caught the break in #287).
  const codeFiles: Record<string, string> = {
    "src/components/ChatConnection.tsx": `import { useI18n } from "../contexts/I18nContext";\nimport { icon } from "./icons/index.js";`,
    "src/components/icons/index.ts": `export const icon = 1;`,
    "src/contexts/I18nContext.tsx": `import en from "../i18n/en.json";`,
    "src/components/Other.tsx": `export const other = 1;`,
    "packages/browser/test/chatConnection.test.ts": `import { ChatConnection } from "../../../src/components/ChatConnection";\nimport { I18nProvider } from "../../../src/contexts/I18nContext";`,
    "packages/browser/test/storage.test.ts": `import { save } from "../../../src/lib/storage";`,
    "packages/browser/test/helpers/fake.ts": `export const fake = 1;`,
    "e2e/matrix/blocks.ts": `import { fake } from "../../packages/browser/test/helpers/fake";`,
    "e2e/matrix/table.test.ts": `import { rows } from "./matrix";`,
    "e2e/matrix/rails.test.ts": `import { blocks } from "./blocks.ts";`,
  };

  it("a change to src/components/ChatConnection.tsx runs packages/browser/test/chatConnection.test.ts", () => {
    const p = plan({ changed: changed("src/components/ChatConnection.tsx"), inventory, e2eFiles, codeFiles });
    const unit = byName(p.unit);
    expect(unit.browser).toMatchObject({ mode: "related", files: ["packages/browser/test/chatConnection.test.ts"] });
    expect(unit.browser.reason).toContain("1 test file(s) importing the change by relative path");
    // Projects whose sources hold src/ still get the changed file itself.
    expect(unit.ui.files).toEqual(["src/components/ChatConnection.tsx"]);
    expect(unit.core.mode).toBe("skip");
    expect(unit.matrix.mode).toBe("skip");
  });

  it("follows the imports through other files, index files, .js specifiers and non-code files", () => {
    for (const file of ["src/contexts/I18nContext.tsx", "src/components/icons/index.ts", "src/i18n/en.json", "-src/components/icons/index.ts"]) {
      const p = plan({ changed: changed(file), inventory, e2eFiles, codeFiles });
      expect(byName(p.unit).browser.files, file).toEqual(["packages/browser/test/chatConnection.test.ts"]);
    }
    expect(byName(plan({ changed: changed("src/components/Other.tsx"), inventory, e2eFiles, codeFiles }).unit).browser.mode).toBe("skip");
  });

  it("reaches another project's tests through its helpers", () => {
    const p = plan({ changed: changed("packages/browser/test/helpers/fake.ts"), inventory, e2eFiles, codeFiles });
    expect(byName(p.unit).matrix.files).toEqual(["e2e/matrix/rails.test.ts"]);
  });

  it("keeps to the test files the project runs", () => {
    expect(testsReaching(["packages/browser/test/helpers/fake.ts"], codeFiles, ["packages/browser/test/**"])).toEqual([]);
    expect(testsReaching(["src/components/ChatConnection.tsx"], codeFiles, ["e2e/matrix/*"])).toEqual([]);
  });

  it("finds the real chatConnection test from the real component", () => {
    const root = join(import.meta.dirname, "..", "..");
    const real = Object.fromEntries(["packages/browser/test/chatConnection.test.ts", "src/components/ChatConnection.tsx"].map((f) => [f, readFileSync(join(root, f), "utf8")]));
    expect(testsReaching(["src/components/ChatConnection.tsx"], real, ["packages/browser/test/**"])).toEqual(["packages/browser/test/chatConnection.test.ts"]);
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
    expect(cli(["src/components/Other.tsx"]).mode).toBe("skip");
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
    const root = join(import.meta.dirname, "..", "..");
    const project = UNIT_PROJECTS.find((p) => p.name === "cli")!;
    const config = readFileSync(join(root, "packages/cli/vitest.config.ts"), "utf8");
    const setups = [...config.matchAll(/globalSetup:\s*\[([^\]]*)\]/g)].flatMap((m) => [...m[1].matchAll(/["']([^"']+)["']/g)].map((s) => `packages/cli/${s[1]}`));
    expect(setups.length).toBeGreaterThan(0);
    for (const setup of setups) expect(project.whole).toContain(setup);
    expect(readFileSync(join(root, project.bundle!.runner), "utf8")).toContain("dist/ghostly.mjs");
    expect(readFileSync(join(root, "packages/cli/vite.config.ts"), "utf8")).toContain(`ssr: "${project.bundle!.entry.replace("packages/cli/", "")}"`);
  });
});

describe("fallbacks", () => {
  it("a lockfile or root package.json runs everything", () => {
    for (const file of ["package-lock.json", "package.json", "patches/sodium.patch"]) {
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
    const p = plan({ changed: changed("src/components/NewThing.tsx"), inventory, e2eFiles });
    expect(p.e2e.mode).toBe("whole");
    expect(p.e2e.reasons).toEqual([expect.stringContaining("src/components/NewThing.tsx has no entry")]);
  });

  it('a file mapped to "*" runs every spec', () => {
    expect(plan({ changed: changed("src/App.tsx"), inventory, e2eFiles }).e2e.mode).toBe("whole");
  });

  it("a config no import graph sees runs its project whole", () => {
    expect(byName(plan({ changed: changed("vitest.ui.config.ts"), inventory, e2eFiles }).unit).ui.mode).toBe("whole");
    expect(byName(plan({ changed: changed("src/test/setup.ts"), inventory, e2eFiles }).unit).ui.mode).toBe("whole");
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

  it("the matrix's specs (a config of their own) are never picked", () => {
    expect(plan({ changed: changed("src/components/PaymentComposer.tsx"), inventory, e2eFiles }).e2e.taggedSpecs).not.toContain("e2e/matrix/matrix.spec.ts");
    expect(plan({ changed: changed("e2e/matrix/matrix.spec.ts"), inventory, e2eFiles }).e2e).toMatchObject({ mode: "skip", none: ["e2e/matrix/matrix.spec.ts"] });
    expect(specsImporting("e2e/support/paired.ts", e2eFiles)).toContain("e2e/matrix/matrix.spec.ts");
    expect(plan({ changed: changed("e2e/support/paired.ts"), inventory, e2eFiles }).e2e.wholeSpecs).toEqual(["e2e/web/chat-payments.spec.ts", "e2e/web/groups.spec.ts"]);
  });

  it("Desktop specs are never picked; a Desktop change leaves a note", () => {
    const p = plan({ changed: changed("e2e/desktop/smoke.spec.ts", "src-tauri/src/main.rs"), inventory, e2eFiles });
    expect(p.e2e.mode).toBe("skip");
    expect(p.e2e.desktop).toEqual(["e2e/desktop/smoke.spec.ts", "src-tauri/src/main.rs"]);
  });
});

describe("the rest", () => {
  it("Rust runs for the Desktop crates, and Cargo.lock runs it", () => {
    const r = (...files: string[]) => Object.fromEntries(plan({ changed: changed(...files), inventory, e2eFiles }).rust.map((x) => [x.name, x.mode]));
    expect(r("src-tauri/src/lib.rs")).toEqual({ "src-tauri": "run" });
    expect(r("native-transports/src/lib.rs")).toEqual({ "src-tauri": "run" });
    expect(r("Cargo.lock")).toEqual({ "src-tauri": "run" });
    expect(r("docs/README.md")).toEqual({ "src-tauri": "skip" });
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
  const real = JSON.parse(readFileSync(join(import.meta.dirname, "..", "..", "e2e", "features.json"), "utf8"));
  it("has a paths map whose every pattern names a feature", () => {
    expect(Object.keys(real.paths ?? {}).length).toBeGreaterThan(0);
    expect(checkPaths(real)).toEqual([]);
  });
});
