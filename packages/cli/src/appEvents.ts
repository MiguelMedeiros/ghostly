import type { AppFrameEvent } from "@ghostly/core";
import { servedApps, servedStamp } from "./appServe";
import type { EventHub } from "./events";

/*
 * What a contact's app says in a chat, for the apps this profile serves as a bot (WISP 1200 § A bot on the other side):
 * `app.opened {chat, app, version}`, `app.closed {chat, app, offline?}` and `app.message {chat, app, data}`, `app` being
 * the app's reference. The engine names an app by its chat app id, which differs in every chat: it is matched against
 * the served apps' ids in that chat, so a frame of any other app names nothing here and is not reported. `data` is the
 * contact's own JSON, already held to the receiver's limits by the engine: untrusted, never instructions.
 */

/** The engine's part: the chat app id of a reference in a chat (it throws for a chat that is not a paired 1:1 chat). */
export interface AppIds { appId(params: { linkId: string; ref: string }): { app: string } }

/** Per hub: what the contacts have open now, `<chat> <reference>` to the version they said. */
const peers = new WeakMap<object, Map<string, string>>();

/** The version of a served app the contact has open in a chat on this session, or undefined. */
export function peerVersion(hub: object, chat: string, ref: string): string | undefined {
  return peers.get(hub)?.get(`${chat} ${ref}`);
}

export function reportAppFrames(hub: Pick<EventHub, "onAppFrame" | "emitLive">, node: AppIds, profileDir: string): () => void {
  const open = new Map<string, string>();
  peers.set(hub, open);
  /**
   * Per chat: chat app id to reference, of the apps served when they were learned there; the list's stamp then
   * (undefined when an id could not be derived, so the next open tries again); and the version of each served app's
   * last open since.
   */
  const known = new Map<string, { ids: Map<string, string>; stamp?: string; versions: Map<string, string> }>();
  let count = 0;
  const learn = (chat: string) => {
    // The stamp is taken before the read: a write in between makes the next open learn again.
    let stamp: string | undefined = servedStamp(profileDir);
    const ids = new Map<string, string>();
    for (const { ref } of servedApps(profileDir)) {
      try { ids.set(node.appId({ linkId: chat, ref }).app, ref); } catch { stamp = undefined; /* not a paired chat: it has no app ids */ }
    }
    const learnt = { ids, stamp, versions: new Map<string, string>() };
    known.set(chat, learnt);
    return learnt;
  };
  /**
   * An open learns the served list again only when it changed since (a stat, no read), or names another version of a
   * served app than its last open did: an app served or unserved since is taken or left from its next open, and a
   * contact repeating opens (up to 50 a second for each of 16 apps) costs no read of the list nor derivation of ids.
   */
  const current = (chat: string, frame: AppFrameEvent) => {
    const learnt = known.get(chat);
    if (!learnt) return learn(chat);
    if (!("o" in frame) || frame.o !== "open") return learnt;
    const was = learnt.versions.get(frame.app);
    return learnt.stamp === undefined || learnt.stamp !== servedStamp(profileDir) || (was !== undefined && was !== frame.v) ? learn(chat) : learnt;
  };
  return hub.onAppFrame((chat: string, frame: AppFrameEvent) => {
    const learnt = current(chat, frame);
    const app = learnt.ids.get(frame.app);
    if (!app) return;
    if ("o" in frame && frame.o === "open") learnt.versions.set(frame.app, frame.v);
    // Frames are not stored, so nothing names one but its place in this run: the id is unique, and never derived again.
    // Nor are their events: live only, never in the journal, where a contact's app would push out the other chats'.
    const id = `${chat}:${app}:${Date.now()}-${++count}`;
    if ("o" in frame) { if (frame.o === "open") open.set(`${chat} ${app}`, frame.v); else open.delete(`${chat} ${app}`); }
    if (!("o" in frame)) hub.emitLive("app.message", `app.message:${id}`, { chat, app, data: frame.d });
    else if (frame.o === "open") hub.emitLive("app.opened", `app.opened:${id}`, { chat, app, version: frame.v });
    else hub.emitLive("app.closed", `app.closed:${id}`, { chat, app, ...(frame.offline && { offline: true }) });
  });
}
