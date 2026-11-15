/*
 * What a group call loads at its join (`useGroupCall`): livekit-client, and the worker that seals and opens the call's
 * media when the group asks for end-to-end encryption (WISP 602). Imported only through `import()`, so neither is in
 * the app's first load.
 */
export { isE2EESupported, Room, RoomEvent, Track } from "livekit-client";
/** A sealed call's keys, each epoch's in its own slot of LiveKit's ring. */
export { GroupCallKeyProvider } from "./groupCallKeys";

/** LiveKit's E2EE worker (a module worker, from this origin), one per sealed room: the room ends it when it closes. */
export function e2eeWorker(): Worker {
  return new Worker(new URL("livekit-client/e2ee-worker", import.meta.url), { type: "module" });
}
