/** Settings that are on or off. */
const SWITCHES = ["online", "mintsInitialized", "shareProfile", "publicProfiles", "sendTyping", "autoDownloads", "serveFiles"] as const;
/** Settings that are lists of addresses. */
const LISTS = ["relays", "irohRelays", "mints"] as const;

const isObject = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);

/**
 * Why a settings patch holds a value of a kind its setting never has, or null. The apps' own patches always have the
 * right kind; one from outside them (`ghostly engine updateSettings`, the socket's `engine.call`) was written as it
 * came, and `mints` as a text left a profile that no longer opened. A key left out (or undefined) is not looked at; the
 * values themselves (an address, a TURN server) are checked where they are used.
 */
export function settingsPatchProblem(patch: Record<string, unknown>): string | null {
  for (const key of SWITCHES) if (patch[key] !== undefined && typeof patch[key] !== "boolean") return `${key} is on or off (true or false)`;
  for (const key of LISTS) {
    const value = patch[key];
    if (value !== undefined && !(Array.isArray(value) && value.every((item) => typeof item === "string"))) return `${key} is a list of addresses`;
  }
  if (patch.nick !== undefined && typeof patch.nick !== "string") return "nick is a text";
  if (patch.iceServers !== undefined && !Array.isArray(patch.iceServers)) return "iceServers is a list of ICE servers";
  const hold = patch.holdStorage;
  if (hold !== undefined && hold !== null && !isObject(hold)) return "holdStorage is the S3 storage and its space, or null";
  if (patch.nostr !== undefined && !isObject(patch.nostr)) return "nostr is an object of Nostr settings";
  return null;
}
