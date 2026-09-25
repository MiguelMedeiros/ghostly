import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { checkPaths, featureGrep, globToRegExp, plan, specsImporting, throughCoreBarrel } from "../affected/select.mjs";

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
    for (const name of ["core", "browser", "sdk", "extension", "ui"]) expect(unit[name].mode).toBe("whole");
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
    expect([...specsImporting("e2e/support/fixtures.ts", e2eFiles)].sort()).toEqual(["e2e/web/chat-payments.spec.ts", "e2e/web/groups.spec.ts"]);
    const p = plan({ changed: changed("e2e/support/mint.ts"), inventory, e2eFiles });
    expect(p.e2e.wholeSpecs).toEqual(["e2e/web/wallet-cashu.spec.ts"]);
    expect(p.typecheck.find((t) => t.name === "e2e")!.mode).toBe("run");
  });

  it("Desktop specs are never picked; a Desktop change leaves a note", () => {
    const p = plan({ changed: changed("e2e/desktop/smoke.spec.ts", "src-tauri/src/main.rs"), inventory, e2eFiles });
    expect(p.e2e.mode).toBe("skip");
    expect(p.e2e.desktop).toEqual(["e2e/desktop/smoke.spec.ts", "src-tauri/src/main.rs"]);
  });
});

describe("the rest", () => {
  it("Rust runs per crate, and Cargo.lock runs both", () => {
    const r = (...files: string[]) => Object.fromEntries(plan({ changed: changed(...files), inventory, e2eFiles }).rust.map((x) => [x.name, x.mode]));
    expect(r("src-tauri/src/lib.rs")).toEqual({ "src-tauri": "run", cli: "skip" });
    expect(r("native-transports/src/lib.rs")).toEqual({ "src-tauri": "run", cli: "skip" });
    expect(r("cli/src/main.rs")).toEqual({ "src-tauri": "skip", cli: "run" });
    expect(r("Cargo.lock")).toEqual({ "src-tauri": "run", cli: "run" });
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
