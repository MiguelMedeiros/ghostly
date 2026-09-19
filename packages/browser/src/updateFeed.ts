import { isNewerVersion } from "@ghostly/core";
import type { FoundUpdate } from "../../../src/lib/updates";

/**
 * What a published version file says. Nothing here is trusted: it arrives from
 * the network, so only these two fields are read, both bounded, and the
 * version has to parse as three numbers before it counts as an update.
 */
export interface VersionFeed {
  version: string;
  /** The exact build, where the publisher marks one. Web deploys move without the version changing. */
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
 * this client already runs it, and throws when the answer never came — the
 * caller shows neither as an update.
 */
export async function checkVersionFeed(options: {
  url: string;
  currentVersion: string;
  /** The build running now, where the client knows it. */
  currentBuild?: string;
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

  const newerVersion = isNewerVersion(feed.version, options.currentVersion);
  // Same version, different build: a deploy this client has not picked up yet.
  const newerBuild =
    !newerVersion &&
    feed.version === options.currentVersion &&
    !!feed.build &&
    !!options.currentBuild &&
    feed.build !== options.currentBuild;

  if (!newerVersion && !newerBuild) return null;
  return { version: feed.version, build: feed.build, apply: options.apply };
}
