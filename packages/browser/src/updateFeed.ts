import { isNewerVersion } from "@ghostly/core";
import type { FoundUpdate } from "../../../apps/ui/src/lib/updates";

/**
 * What a published version file says. Nothing here is trusted: it arrives from
 * the network, so only these two fields are read, both bounded, and the
 * version has to parse as three numbers before it counts as an update.
 */
export interface VersionFeed {
  version: string;
  /** The exact build, where the publisher marks one. Kept on the update; never a reason for one. */
  build?: string;
}

/** Longest response read. A version file is a few dozen bytes; this is already generous. */
const MAX_FEED_BYTES = 4096;
const TIMEOUT_MS = 8000;

function readFeed(text: string): VersionFeed | null {
  if (text.length > MAX_FEED_BYTES) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const { version, build } = parsed as Record<string, unknown>;
  if (typeof version !== "string" || version.length > 64) return null;
  return { version, build: typeof build === "string" && build.length <= 64 ? build : undefined };
}

/**
 * Asks a published version file what the newest version is. Returns null when
 * this client already runs it or a newer one (by version number, whatever the
 * build, unless this build is gone), and throws when the answer never came: the
 * caller shows neither as an update.
 */
export async function checkVersionFeed(options: {
  url: string;
  currentVersion: string;
  /** The build running now, where the client knows it. A reason for an update only once this build is gone. */
  currentBuild?: string;
  /**
   * The server no longer has this build's files (the web app's worker got a 404 for one): another build is then an
   * update whatever its version, since what runs cannot load what it needs. The same version is offered as a new
   * build; an older one (a rollback) by its version, as any update.
   */
  buildGone?: boolean;
  /** What the UI will offer once there is an update. */
  apply: "reload" | "manual";
}): Promise<FoundUpdate | null> {
  const response = await fetch(options.url, {
    cache: "no-store",
    credentials: "omit",
    referrerPolicy: "no-referrer",
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`The update check answered ${response.status}`);

  const feed = readFeed(await response.text());
  if (!feed) throw new Error("The update check answered with something else");

  // Versions only, compared as numbers. A new build of the same version is not an update: the banner names a
  // version, and "Ghostly 1.1.4 is available" on 1.1.4 reads as a bug. The service worker picks a redeploy up once
  // no tab of the app is left. Unless this build is gone from the server: then a wallet opened now fails for good,
  // so another build is offered. The same version is named as a new build of it; an older one is a rollback, and
  // "a new build of 1.1.3" on 1.1.4 would be a lie, so it is named by its version like any update.
  if (isNewerVersion(feed.version, options.currentVersion)) return { version: feed.version, build: feed.build, apply: options.apply };
  if (!options.buildGone || !feed.build || feed.build === options.currentBuild) return null;
  if (feed.version === options.currentVersion) return { version: feed.version, build: feed.build, replaced: true, apply: options.apply };
  return { version: feed.version, build: feed.build, apply: options.apply };
}
