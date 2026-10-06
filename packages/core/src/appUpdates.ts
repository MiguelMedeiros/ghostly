import { appRefPublisher, type SignedAppRevocation } from "./appStatements";
import type { AppRemoval, AppStoreKind } from "./appStore";

/*
 * The client's rules for updates, rollback, removals and revocations (WISP 1200 · Updates and rollback, Takedowns), as
 * pure functions over what the client holds. A client keeps, per installed app, the reference (publisher key and
 * name), the highest `sequence` it has seen and the digest of that version; per store, its key, `sequence` and the
 * digest of its index. Where a version came from never matters: the bytes are checked, not the messenger.
 */

/** A version of an app, as the client holds it or a checked bundle shows it. */
export interface AppVersion { ref: string; sequence: number; digest: string }

/**
 * What a valid package means next to the installed one:
 * - `update`: the same app with a higher `sequence`, from anywhere;
 * - `same`: the version installed;
 * - `rollback`: a lower `sequence`, never installed over a higher one;
 * - `equivocation`: the same `sequence` with another digest; the client keeps what it runs, refuses the other and marks
 *   the app ("Two different versions 7 exist");
 * - `other-app`: another reference (another publisher key or another name), never an update of this one.
 */
export type AppUpdateDecision = "update" | "same" | "rollback" | "equivocation" | "other-app";

export function appUpdateDecision(installed: AppVersion, candidate: AppVersion): AppUpdateDecision {
  if (installed.ref !== candidate.ref) return "other-app";
  if (candidate.sequence > installed.sequence) return "update";
  if (candidate.sequence < installed.sequence) return "rollback";
  return candidate.digest === installed.digest ? "same" : "equivocation";
}

/** The permissions an update adds: when there is any, the update waits for the person, who sees only these. */
export function addedAppPermissions(granted: readonly string[], requested: readonly string[]): string[] {
  return requested.filter((p) => !granted.includes(p));
}

/**
 * What to do with a newer package: install it (the permissions it keeps or drops apply by themselves) or ask about the
 * permissions it adds. Anything but `update` from `appUpdateDecision` is not installed.
 */
export type AppUpdatePlan =
  | { action: "install" }
  | { action: "ask"; added: string[] }
  | { action: "refuse"; decision: Exclude<AppUpdateDecision, "update"> };

export function planAppUpdate(installed: AppVersion & { permissions: readonly string[] }, candidate: AppVersion & { permissions: readonly string[] }): AppUpdatePlan {
  const decision = appUpdateDecision(installed, candidate);
  if (decision !== "update") return { action: "refuse", decision };
  const added = addedAppPermissions(installed.permissions, candidate.permissions);
  return added.length ? { action: "ask", added } : { action: "install" };
}

/**
 * The revocation that stops a version, or null: one signed by the app's own publisher (a reader verified it) that names
 * its digest, or reaches its `sequence` with `upTo`.
 */
export function appRevocationFor(version: AppVersion, revocations: readonly SignedAppRevocation[]): SignedAppRevocation | null {
  const publisher = appRefPublisher(version.ref);
  for (const r of revocations) {
    const s = r.statement;
    if (s.app !== version.ref || r.signature.key !== publisher) continue;
    if ("digests" in s ? s.digests.includes(version.digest) : version.sequence <= s.upTo) return r;
  }
  return null;
}

/** A store the person added, as the run check needs it. */
export interface AppStoreView { key: string; name: string; kind: AppStoreKind; removed: readonly AppRemoval[]; revoked: readonly SignedAppRevocation[] }

/**
 * The check before Install is enabled, at every update check and before a run:
 * - `revoked`: its publisher revoked it; it stops, with no "Run anyway";
 * - `removed`: a store the person added removed this digest; it stops and the person decides (Remove, Keep it stopped,
 *   or, behind Details, Run anyway);
 * - `ok`.
 * Revocations come from the app's sources and from every store's `revoked`; a store the person did not add has no say.
 */
export type AppRunCheck =
  | { status: "ok" }
  | { status: "revoked"; revocation: SignedAppRevocation }
  | { status: "removed"; by: { store: string; name: string; reason: string; at: number }[] };

export function checkAppBeforeRun(version: AppVersion, stores: readonly AppStoreView[], revocations: readonly SignedAppRevocation[] = []): AppRunCheck {
  const revocation = appRevocationFor(version, [...revocations, ...stores.flatMap((s) => s.revoked)]);
  if (revocation) return { status: "revoked", revocation };
  const by = stores.flatMap((s) => s.removed
    .filter((r) => r.ref === version.ref && r.digest === version.digest)
    .map((r) => ({ store: s.key, name: s.name, reason: r.reason, at: r.at })));
  return by.length ? { status: "removed", by } : { status: "ok" };
}

/** A store index as the client holds it. */
export interface AppStoreVersion { key: string; sequence: number; digest: string }

/**
 * What a newly read index means next to the one held: `new` (none held), `update`, `same`, `rollback` (a lower
 * `sequence`, refused), `equivocation` (the same `sequence`, other bytes: refused, the held one kept) or `other-key`
 * (another store: a store is its key).
 */
export type AppStoreDecision = "new" | "update" | "same" | "rollback" | "equivocation" | "other-key";

export function appStoreDecision(held: AppStoreVersion | null, read: AppStoreVersion): AppStoreDecision {
  if (!held) return "new";
  if (held.key !== read.key) return "other-key";
  if (read.sequence > held.sequence) return "update";
  if (read.sequence < held.sequence) return "rollback";
  return read.digest === held.digest ? "same" : "equivocation";
}
