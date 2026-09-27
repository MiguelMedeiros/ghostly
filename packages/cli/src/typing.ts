import { TYPING_REFRESH_MS } from "@ghostly/core";
import { node, type ApiContext } from "./apiKit";

/**
 * `typing --for`: a `start` holds 6 s on the contact's side (WISP 401 § Typing), so the daemon says it again until
 * the time is up, a message goes to that chat, or a `typing --stop`. The engine sends a `start` at most once per
 * refresh: asking twice as often keeps one out before the contact's timeout.
 */
const KEEP_EVERY_MS = TYPING_REFRESH_MS / 2;
const keepers = new WeakMap<ApiContext, Map<string, () => void>>();

function keepersOf(ctx: ApiContext): Map<string, () => void> {
  let map = keepers.get(ctx);
  if (!map) keepers.set(ctx, (map = new Map()));
  return map;
}

/** Says this side is typing in the chat for `ms`; resolves when that ends, whichever way. */
export function keepTyping(ctx: ApiContext, linkId: string, ms: number): Promise<void> {
  endTyping(ctx, linkId, false);
  const map = keepersOf(ctx);
  return new Promise<void>((resolve) => {
    const end = () => { clearInterval(again); clearTimeout(until); off(); if (map.get(linkId) === end) map.delete(linkId); resolve(); };
    const again = setInterval(() => node(ctx).setTyping({ linkId, typing: true }), KEEP_EVERY_MS);
    const until = setTimeout(() => { end(); node(ctx).setTyping({ linkId, typing: false }); }, ms);
    // A message ends it, sent from anywhere (the engine said `stop` with it).
    const off = ctx.hub.onEvent((event) => { if (event.type === "message.sent" && event.chat === linkId) end(); });
    map.set(linkId, end);
  });
}

/** Ends a kept `typing --for` in the chat; `tell`: and says this side stopped. Whether one was kept. */
export function endTyping(ctx: ApiContext, linkId: string, tell: boolean): boolean {
  const end = keepersOf(ctx).get(linkId);
  if (!end) return false;
  end();
  if (tell) node(ctx).setTyping({ linkId, typing: false });
  return true;
}
