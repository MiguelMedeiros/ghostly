import { describe, expect, it } from "vitest";
import { COMMANDS, SHARED, blanked, envTarget, gatedTests, stackDecision, statusWhy } from "../affected/stack.mjs";

const GATES = ["GHOSTLY_CLN_REGTEST", "GHOSTLY_S3_ENDPOINT", "GHOSTLY_ARK_REGTEST"];

const e2eFiles: Record<string, string> = {
  "e2e/web/wallet-cln.spec.ts": `test.skip(process.env.GHOSTLY_CLN_REGTEST !== "1", "…");
test("in", { tag: ["@gated", "@feature:wallet.cln.connect"] }, () => {});
test("chat", { tag: ["@gated", "@feature:wallet.cln.connect", "@feature:payments.request"] }, () => {});`,
  "e2e/web/store-forward.spec.ts": `const endpoint = process.env.GHOSTLY_S3_ENDPOINT ?? "";
test("held", { tag: ["@feature:delivery.hold", "@gated"] }, () => {});
test("legacy", { tag: ["@feature:delivery.legacy"] }, () => {});`,
  "e2e/web/breez.spec.ts": `test.describe("hosted", { tag: "@network" }, () => {
  test.skip(!process.env.GHOSTLY_BREEZ_TESTNET, "…");
  test("pay", { tag: ['@feature:wallet.breez.pay', '@gated'] }, () => {});
});`,
  "e2e/web/home.spec.ts": `test("h", { tag: ["@feature:app.home"] }, () => {});`,
  // A variable's name inside a longer one is not that variable.
  "e2e/web/ark-like.spec.ts": `const x = process.env.GHOSTLY_ARK_REGTEST_OLD;
test("a", { tag: ["@gated", "@feature:wallet.ark"] }, () => {});`,
};

describe("gatedTests", () => {
  it("counts every @gated test of a spec that runs whole, and splits by what they wait on", () => {
    const g = gatedTests({ mode: "whole", specs: Object.keys(e2eFiles) }, e2eFiles, GATES);
    expect(g.stack).toEqual([{ spec: "e2e/web/wallet-cln.spec.ts", tests: 2 }, { spec: "e2e/web/store-forward.spec.ts", tests: 1 }]);
    expect(g.stackTests).toBe(3);
    expect(g.other).toEqual([{ spec: "e2e/web/breez.spec.ts", tests: 1 }, { spec: "e2e/web/ark-like.spec.ts", tests: 1 }]);
    expect(g.otherTests).toBe(2);
  });

  it("in a spec picked by tag, only the @gated tests tagged with an affected feature", () => {
    const g = gatedTests({ mode: "select", wholeSpecs: [], taggedSpecs: ["e2e/web/wallet-cln.spec.ts", "e2e/web/store-forward.spec.ts"], features: ["payments.request", "delivery.legacy"] }, e2eFiles, GATES);
    expect(g.stack).toEqual([{ spec: "e2e/web/wallet-cln.spec.ts", tests: 1 }]);
    expect(g.stackTests).toBe(1);
  });

  it("a changed spec runs whole: all its @gated tests, whatever the features", () => {
    const g = gatedTests({ mode: "select", wholeSpecs: ["e2e/web/store-forward.spec.ts"], taggedSpecs: [], features: [] }, e2eFiles, GATES);
    expect(g.stackTests).toBe(1);
  });

  it("nothing when the e2e is skipped or nothing picked is gated", () => {
    expect(gatedTests({ mode: "skip" }, e2eFiles, GATES).stackTests).toBe(0);
    expect(gatedTests({ mode: "select", wholeSpecs: ["e2e/web/home.spec.ts"], taggedSpecs: [], features: [] }, e2eFiles, GATES)).toEqual({ stack: [], other: [], stackTests: 0, otherTests: 0 });
  });
});

describe("envTarget", () => {
  it("reads where .env.e2e points", () => {
    expect(envTarget(null)).toBe("none");
    expect(envTarget("# comment\nGHOSTLY_ARK_REGTEST=1\n")).toBe("local");
    expect(envTarget("GHOSTLY_ARK_REGTEST=1\n# SSH target\nE2E_INFRA_HOST=miguel@one\nDOCKER_HOST=unix:///tmp/x.sock\n")).toBe("miguel@one");
  });
});

describe("stackDecision", () => {
  const base = { tests: 4 };

  it("does nothing when no picked test needs the stack", () => {
    expect(stackDecision({ tests: 0, env: "none", check: "silent" })).toEqual({ use: false, blank: false, lines: [] });
  });

  it("stack answers and .env.e2e points there: nothing to do", () => {
    const d = stackDecision({ ...base, env: SHARED.host, check: "answers" });
    expect(d).toMatchObject({ use: false, blank: false });
    expect(d.lines[0]).toMatch(/answers and \.env\.e2e points there: 4 gated test\(s\) run on it/);
  });

  it("stack answers and .env.e2e does not point there: join it, and print the command", () => {
    for (const env of ["none", "local", "someone@elsewhere"]) {
      const d = stackDecision({ ...base, env, check: "answers" });
      expect(d).toMatchObject({ use: true, blank: false });
      expect(d.lines.join("\n")).toContain(COMMANDS.use);
    }
    expect(stackDecision({ ...base, env: "local", check: "answers" }).lines[0]).toContain("in place of .env.e2e's stack on this machine");
    expect(stackDecision({ ...base, env: "none", check: "answers" }).lines[0]).toContain("joining it first");
    expect(stackDecision({ ...base, env: "none", check: "answers", list: true }).lines[0]).toContain("a run joins it first");
  });

  it("stack silent, no .env.e2e: says how many skip and how to run them, never offers to start one here", () => {
    const d = stackDecision({ ...base, env: "none", check: "silent", why: "no containers there" });
    expect(d).toMatchObject({ use: false, blank: false });
    expect(d.lines[0]).toBe("the shared stack on one does not answer (no containers there): 4 gated test(s) will skip");
    expect(d.lines.join("\n")).toContain(COMMANDS.status);
    expect(d.lines.join("\n")).not.toMatch(/infra:(?:up|down|reset)/);
  });

  it("stack silent but .env.e2e points there: blank its variables so the tests skip instead of hitting dead ports", () => {
    const d = stackDecision({ ...base, env: SHARED.host, check: "silent" });
    expect(d).toMatchObject({ use: false, blank: true });
    expect(d.lines[0]).toContain("4 gated test(s) will skip; .env.e2e points there");
  });

  it("stack silent, .env.e2e names another stack: left alone, used as it is", () => {
    for (const env of ["local", "someone@elsewhere"]) {
      const d = stackDecision({ ...base, env, check: "silent" });
      expect(d).toMatchObject({ use: false, blank: false });
      expect(d.lines[0]).toMatch(/run against the stack \.env\.e2e names/);
    }
  });

  it("joining failed: the tests skip, and it says the stack answered", () => {
    const d = stackDecision({ ...base, env: "none", check: "unjoined", why: "use failed" });
    expect(d).toMatchObject({ use: false, blank: false });
    expect(d.lines[0]).toBe("the shared stack on one answers, but this checkout could not join it (use failed): 4 gated test(s) will skip");
  });

  it("not checked: says what a run does, changes nothing", () => {
    const d = stackDecision({ ...base, env: "none", check: "unchecked", why: "--list opens no connection" });
    expect(d).toMatchObject({ use: false, blank: false });
    expect(d.lines.join("\n")).toContain(COMMANDS.status);
    expect(d.lines.join("\n")).toContain(COMMANDS.use);
  });
});

describe("statusWhy", () => {
  it("an SSH failure", () => {
    // Uncaught at import: node prints the source line (which says "Could not connect" too) before the error.
    expect(statusWhy("file:///x/remote.mjs:67\n  if (started.status !== 0) throw new Error(`Could not connect to ${HOST}: …`);\n                ^\n\nError: Could not connect to miguel@one: ssh: connect to host one port 22: Operation timed out\n    at connect")).toBe("Could not connect to miguel@one: ssh: connect to host one port 22: Operation timed out");
  });

  it("stopped containers and silent endpoints", () => {
    const out = `ghostly-e2e-bitcoind            running (healthy)  2 hours ago
ghostly-e2e-arkd                exited  2 hours ago
ghostly-e2e-lnd-alice           running (starting)  1 minute ago
answers  bitcoind RPC
SILENT   arkd
SILENT   LND alice / bob
ghostly-e2e on miguel@one (100.81.12.32): NOT READY`;
    expect(statusWhy(out)).toBe("arkd exited, lnd-alice starting; silent: arkd, LND alice / bob");
  });

  it("no stack at all", () => {
    expect(statusWhy("ghostly-e2e on miguel@one (100.81.12.32) is not running.\n")).toBe("no containers there");
  });

  it("ports held by a local stack (status's warning, check's verdict)", () => {
    const warning = "WARNING: 127.0.0.1:47001,47002 cannot be forwarded to miguel@one: a local ghostly-e2e stack holds them (started from /w/a since 2026-09-24T10:00:00Z): whoever started it stops it there with npm run e2e:infra:down. Or set E2E_INFRA_LOCAL_PORTS=<first free port> …";
    expect(statusWhy(`${warning}\nghostly-e2e on miguel@one (100.81.12.32): NOT READY`)).toBe("its ports cannot be forwarded here: a local ghostly-e2e stack holds them (started from /w/a since 2026-09-24T10:00:00Z)");
    expect(statusWhy("ghostly-e2e on miguel@one: NOT READY here: a local ghostly-e2e stack holds its ports (started from /w/a)")).toBe("a local ghostly-e2e stack holds its ports (started from /w/a)");
  });

  it("anything else: the last line", () => {
    expect(statusWhy("something\nghostly-e2e on miguel@one: NOT READY\n")).toBe("ghostly-e2e on miguel@one: NOT READY");
  });
});

describe("blanked", () => {
  it("empties each variable (set in the shell, it wins over .env.e2e)", () => {
    expect(blanked(["GHOSTLY_ARK_REGTEST", "E2E_MINT_URL"])).toEqual({ GHOSTLY_ARK_REGTEST: "", E2E_MINT_URL: "" });
  });
});
