import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { LinkView } from "@ghostly/browser/shared/types";
import { node, state, type ApiContext } from "./apiKit";
import { CliError } from "./errors";

/**
 * `chat disconnect --hold <minutes>`: a chat kept off its direct link for a while. It is the chat's own "DHT only"
 * choice (WISP 400: either side choosing it keeps both off the live link, so the contact's app does not redial),
 * taken back when the time is up. Text still goes over the DHT (short texts), files wait. The holds are kept in
 * the profile folder: a daemon that restarts takes back the ones whose time is up, and never a DHT only the chat had
 * chosen before (that one is not a hold).
 */
export const HOLD_MAX_MINUTES = 7 * 24 * 60;

interface Hold { until: number; since: number }
type Holds = Record<string, Hold>;

const timers = new WeakMap<ApiContext, Map<string, ReturnType<typeof setTimeout>>>();

function holdsFile(ctx: ApiContext): string {
  return join(ctx.runtime.paths.dir, "holds.json");
}

function readHolds(ctx: ApiContext): Holds {
  try { return JSON.parse(readFileSync(holdsFile(ctx), "utf8")) as Holds; } catch { return {}; }
}

function writeHolds(ctx: ApiContext, holds: Holds): void {
  const file = holdsFile(ctx);
  writeFileSync(file + ".tmp", JSON.stringify(holds) + "\n", { mode: 0o600 });
  renameSync(file + ".tmp", file);
}

function timersOf(ctx: ApiContext): Map<string, ReturnType<typeof setTimeout>> {
  let map = timers.get(ctx);
  if (!map) timers.set(ctx, (map = new Map()));
  return map;
}

function schedule(ctx: ApiContext, linkId: string, until: number): void {
  const map = timersOf(ctx);
  clearTimeout(map.get(linkId));
  const timer = setTimeout(() => {
    map.delete(linkId);
    void releaseHold(ctx, linkId, "expired").catch((error: unknown) => process.stderr.write(`ghostly: the hold on ${linkId} could not end: ${error instanceof Error ? error.message : String(error)}\n`));
  }, Math.max(0, until - Date.now()));
  // A one-shot leaves when its command is done; the next start takes the hold back.
  timer.unref?.();
  map.set(linkId, timer);
}

/** When the chat's hold ends, or null. */
export function holdOf(ctx: ApiContext, linkId: string): number | null {
  return readHolds(ctx)[linkId]?.until ?? null;
}

/** Keeps the chat off its direct link for `minutes` (again: from now). */
export async function holdChat(ctx: ApiContext, link: LinkView, minutes: number): Promise<number> {
  const holds = readHolds(ctx);
  if (link.deliveryMode === "dht" && !holds[link.id]) throw new CliError("refused", "This chat is on DHT only already, by its own choice: chat transport auto leaves it");
  if (!link.profile) throw new CliError("unavailable", "A chat of the older protocol has no DHT only");
  const until = Date.now() + minutes * 60_000;
  if (link.deliveryMode !== "dht") {
    try { await node(ctx).setChatTransport({ linkId: link.id, transport: "dht" }); } catch (error) {
      throw new CliError("unavailable", error instanceof Error ? error.message : String(error));
    }
  }
  holds[link.id] = { until, since: holds[link.id]?.since ?? Date.now() };
  writeHolds(ctx, holds);
  schedule(ctx, link.id, until);
  ctx.hub.emit("chat.held", `chat.held:${link.id}:${until}`, { chat: link.id, until });
  return until;
}

/**
 * Ends a hold: the chat leaves DHT only, unless someone chose otherwise meanwhile. Whether there was one. `reason`:
 * expired, connect (`chat connect`) or lifted (`--hold 0`).
 */
export async function releaseHold(ctx: ApiContext, linkId: string, reason: "expired" | "connect" | "lifted"): Promise<boolean> {
  const holds = readHolds(ctx);
  if (!holds[linkId]) return false;
  clearTimeout(timersOf(ctx).get(linkId));
  timersOf(ctx).delete(linkId);
  const link = state(ctx).links.find((l) => l.id === linkId);
  if (link?.deliveryMode === "dht") await node(ctx).setDeliveryMode({ linkId, mode: "stream" });
  delete holds[linkId];
  writeHolds(ctx, holds);
  ctx.hub.emit("chat.released", `chat.released:${linkId}:${Date.now()}`, { chat: linkId, reason });
  return true;
}

/** At start: holds whose time is up end now, the others are timed again. */
export function resumeHolds(ctx: ApiContext): void {
  for (const [linkId, hold] of Object.entries(readHolds(ctx))) schedule(ctx, linkId, hold.until);
}
