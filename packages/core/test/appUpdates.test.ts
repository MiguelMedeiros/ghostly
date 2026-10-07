import { describe, expect, it } from "vitest";
import {
  addedAppPermissions, appRef, appRevocationFor, buildAppBundle, checkAppBeforeRun, planAppUpdate, signAppObject, signAppRevocation,
  APP_PREFIXES, type AppStoreView, type AppVersion, type SignedAppRevocation,
} from "../src/index";
import { DRAFT, ENTRY, appKey, appSigner } from "./appVectors";
// covers: apps.updates

/*
 * The client's update rules (WISP 1200 · Updates and rollback, Takedowns): what a newer package means, which
 * permissions re-ask, and the check of removals and revocations before Install, at every update check and before a run.
 */

const publisher = appSigner("publisher");
const REF = appRef(appKey("publisher"), "chess");
const v = (sequence: number, digest = `d${sequence}`.padEnd(43, "A")): AppVersion => ({ ref: REF, sequence, digest });

describe("updates", () => {
  it("installs a higher sequence by itself when it adds no permission, and asks for only what it adds", () => {
    expect(planAppUpdate({ ...v(1), permissions: ["chat"] }, { ...v(2), permissions: ["chat"] })).toEqual({ action: "install" });
    expect(planAppUpdate({ ...v(1), permissions: ["chat", "name"] }, { ...v(2), permissions: ["chat"] })).toEqual({ action: "install" });
    expect(planAppUpdate({ ...v(1), permissions: [] }, { ...v(2), permissions: ["chat", "name"] })).toEqual({ action: "ask", added: ["chat", "name"] });
    expect(planAppUpdate({ ...v(1), permissions: ["chat"] }, { ...v(2), permissions: ["name", "chat"] })).toEqual({ action: "ask", added: ["name"] });
    // The internet is asked for again like any other: an app that had no network never gets it by an update alone.
    expect(planAppUpdate({ ...v(1), permissions: ["chat"] }, { ...v(2), permissions: ["chat", "internet"] })).toEqual({ action: "ask", added: ["internet"] });
    expect(planAppUpdate({ ...v(1), permissions: ["internet", "chat"] }, { ...v(2), permissions: ["chat"] })).toEqual({ action: "install" });
    expect(addedAppPermissions(["chat"], ["chat"])).toEqual([]);
  });

  it("never installs a rollback, an equivocation, the same version or another app", () => {
    expect(planAppUpdate({ ...v(5), permissions: [] }, { ...v(4), permissions: [] })).toEqual({ action: "refuse", decision: "rollback" });
    expect(planAppUpdate({ ...v(5), permissions: [] }, { ...v(5, "x".repeat(43)), permissions: [] })).toEqual({ action: "refuse", decision: "equivocation" });
    expect(planAppUpdate({ ...v(5), permissions: [] }, { ...v(5), permissions: ["chat"] })).toEqual({ action: "refuse", decision: "same" });
    expect(planAppUpdate({ ...v(5), permissions: [] }, { ...v(6), ref: appRef(appKey("other publisher"), "chess"), permissions: [] })).toEqual({ action: "refuse", decision: "other-app" });
    expect(planAppUpdate({ ...v(5), permissions: [] }, { ...v(6), ref: appRef(appKey("publisher"), "checkers"), permissions: [] })).toEqual({ action: "refuse", decision: "other-app" });
  });
});

describe("removals and revocations before a run", () => {
  const revocations = async () => {
    const one = await signAppRevocation({ ghostlyRevoke: 1, app: REF, digests: [v(3).digest] }, publisher);
    const upTo = await signAppRevocation({ ghostlyRevoke: 1, app: REF, upTo: 2 }, publisher);
    return { one, upTo };
  };
  const view = (removed: AppStoreView["removed"], revoked: SignedAppRevocation[] = [], name = "Default"): AppStoreView => ({ key: appKey("store"), name, kind: "curated", removed, revoked });

  it("stops a version its publisher revoked, by digest or up to a sequence, from its sources or any store", async () => {
    const { one, upTo } = await revocations();
    expect(appRevocationFor(v(3), [one])).toBe(one);
    expect(appRevocationFor(v(4), [one])).toBeNull();
    expect(appRevocationFor(v(1), [upTo])).toBe(upTo);
    expect(appRevocationFor(v(2), [upTo])).toBe(upTo);
    expect(appRevocationFor(v(3), [upTo])).toBeNull();
    expect(checkAppBeforeRun(v(3), [], [one])).toEqual({ status: "revoked", revocation: one });
    expect(checkAppBeforeRun(v(2), [view([], [upTo])])).toEqual({ status: "revoked", revocation: upTo });
  });

  it("takes a revocation only from the app's own publisher and for that app", async () => {
    const { signature } = await signAppObject(APP_PREFIXES.revoke, { ghostlyRevoke: 1, app: REF, upTo: 9 }, appSigner("store"));
    const forged: SignedAppRevocation = { statement: { ghostlyRevoke: 1, app: REF, upTo: 9 }, signature };
    expect(appRevocationFor(v(1), [forged])).toBeNull();
    const otherApp = await signAppRevocation({ ghostlyRevoke: 1, app: appRef(appKey("publisher"), "checkers"), upTo: 9 }, publisher);
    expect(appRevocationFor(v(1), [otherApp])).toBeNull();
  });

  it("stops a digest a store removed, and names every store that did", () => {
    const removal = { ref: REF, digest: v(3).digest, reason: "Malware", at: 1 };
    const result = checkAppBeforeRun(v(3), [view([removal]), view([{ ...removal, reason: "Steals moves" }], [], "Second")]);
    expect(result).toEqual({ status: "removed", by: [
      { store: appKey("store"), name: "Default", reason: "Malware", at: 1 },
      { store: appKey("store"), name: "Second", reason: "Steals moves", at: 1 },
    ] });
    expect(checkAppBeforeRun(v(4), [view([removal])])).toEqual({ status: "ok" });
    expect(checkAppBeforeRun({ ...v(3), ref: appRef(appKey("publisher"), "checkers") }, [view([removal])])).toEqual({ status: "ok" });
  });

  it("puts a revocation before a removal: a revoked app has no Run anyway", async () => {
    const { one } = await revocations();
    const removal = { ref: REF, digest: v(3).digest, reason: "Malware", at: 1 };
    expect(checkAppBeforeRun(v(3), [view([removal], [one])]).status).toBe("revoked");
  });

  it("runs an app no store removed and no publisher revoked", async () => {
    const built = await buildAppBundle(DRAFT, [ENTRY], publisher);
    expect(checkAppBeforeRun({ ref: REF, sequence: built.manifest.sequence, digest: built.digest }, [view([])])).toEqual({ status: "ok" });
  });
});
