import type { AppFrameEvent } from "@ghostly/core";
import { servedApps } from "./appServe";
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

export function reportAppFrames(hub: Pick<EventHub, "onAppFrame" | "emit">, node: AppIds, profileDir: string): () => void {
  /** Per chat: chat app id to reference, of the apps served when the contact last opened one there. */
  const known = new Map<string, Map<string, string>>();
  let count = 0;
  const learn = (chat: string): Map<string, string> => {
    const ids = new Map<string, string>();
    for (const { ref } of servedApps(profileDir)) {
      try { ids.set(node.appId({ linkId: chat, ref }).app, ref); } catch { /* not a paired chat: it has no app ids */ }
    }
    known.set(chat, ids);
    return ids;
  };
  return hub.onAppFrame((chat: string, frame: AppFrameEvent) => {
    // An open reads the served list again, so an app served or unserved since is taken or left from its next open.
    const app = ("o" in frame && frame.o === "open" ? learn(chat) : known.get(chat) ?? learn(chat)).get(frame.app);
    if (!app) return;
    // Frames are not stored, so nothing names one but its place in this run: the id is unique, and never derived again.
    const id = `${chat}:${app}:${Date.now()}-${++count}`;
    if (!("o" in frame)) hub.emit("app.message", `app.message:${id}`, { chat, app, data: frame.d });
    else if (frame.o === "open") hub.emit("app.opened", `app.opened:${id}`, { chat, app, version: frame.v });
    else hub.emit("app.closed", `app.closed:${id}`, { chat, app, ...(frame.offline && { offline: true }) });
  });
}
