import { appCardId, type AppCard } from "@ghostly/core";
import { bool, chatOf, node, str, type ApiContext, type Method, type Params } from "./apiKit";
import { peerVersion } from "./appEvents";
import { servedApp, servedApps, type ServedApp } from "./appServe";
import { CliError } from "./errors";
import { isLive } from "./views";

/*
 * A served app in a chat (WISP 1200 § A bot on the other side): `app open` says the app is open on this side and, when
 * the contact's app is not open there yet, sends the app's card, as a person's app does when they open one; `app close`
 * ends it. What is open is the engine's, in memory: only a daemon holds it, and a restarted one opens again.
 */

/** The chat and the served app a command names, on an engine that speaks apps/1. */
function target(ctx: ApiContext, params: Params): { chat: string; live: boolean; app: ServedApp } {
  const app = servedApp(servedApps(ctx.runtime.paths.dir), str(params, "ref", true));
  if (ctx.mode !== "daemon") throw new CliError("unavailable", "An app is open only while a daemon runs: start one (ghostly daemon start) and open it there");
  if (!ctx.runtime.apps) throw new CliError("unavailable", "This daemon started before an app was served, so it offers no apps/1 yet: ghostly daemon restart");
  const link = chatOf(ctx, params);
  return { chat: link.id, live: isLive(link), app };
}

/** The engine's own words for a call it refused (a chat not paired yet, a group), as `refused`. */
async function engine<T>(run: () => T | Promise<T>): Promise<T> {
  try { return await run(); } catch (error) { throw new CliError("refused", error instanceof Error ? error.message : String(error)); }
}

export const APP_CHAT_METHODS: Record<string, Method> = {
  async "app.open"(ctx, params) {
    const { chat, live, app } = target(ctx, params);
    const peer = peerVersion(ctx.hub, chat, app.ref) ?? null;
    await engine(() => node(ctx).appOpen({ linkId: chat, ref: app.ref, version: app.version }));
    let card: string | null = null;
    // The card is how a person learns of the app and gets it ("Install to play"); one whose app is open has no use for it.
    if (!bool(params, "noCard") && peer === null) {
      const sent: AppCard = { kind: "app", id: appCardId(app.ref), ref: app.ref, digest: app.digest, sequence: app.sequence, title: app.title, version: app.version, ...(app.url !== undefined && { url: app.url }), opened: true };
      const result = await node(ctx).sendMessage({ linkId: chat, text: "", card: sent });
      if (result.error || !result.messageId) {
        // Not half open: with no card the contact would never know, so the open is taken back.
        await engine(() => node(ctx).appClose({ linkId: chat, ref: app.ref }));
        throw new CliError(result.refused ? "refused" : "unavailable", result.error ?? "The app's card could not be sent");
      }
      card = result.messageId;
    }
    return { chat, app: app.ref, version: app.version, card, peer, live };
  },

  async "app.close"(ctx, params) {
    const { chat, app } = target(ctx, params);
    await engine(() => node(ctx).appClose({ linkId: chat, ref: app.ref }));
    return { chat, app: app.ref, closed: true };
  },
};
