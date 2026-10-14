import type { IceServerSetting } from "./types";

/**
 * What is wrong with a TURN/STUN server, or null. Browsers refuse to create any WebRTC connection when
 * one server in the list is malformed, so a bad entry here would silently cut off calls and files.
 */
export function iceServerProblem(server: IceServerSetting): string | null {
  // A setting from outside the form (the CLI, `ghostly engine`, an import) may have no urls at all: before, a TypeError.
  if (typeof server?.urls !== "string") return "Each ICE server needs urls: one address, or several comma-separated (turn:host:port)";
  const urls = server.urls.split(/[\s,]+/).filter(Boolean);
  if (!urls.length) return "Enter the TURN server address";
  for (const url of urls) {
    if (!/^(stun|turns?):[^\s/?#]+(\?transport=(udp|tcp))?$/i.test(url)) return `“${url}” is not a TURN or STUN address (turn:host:port)`;
    if (/^turns?:/i.test(url) && (!server.username?.trim() || !server.credential?.trim())) return "A TURN server needs its username and credential";
  }
  return null;
}

/**
 * A server as WebRTC writes it (`urls` a list, as every TURN guide does) in this setting's own form: the addresses
 * comma-separated. Anything else is left as it is, for `iceServerProblem` to say what is wrong.
 */
export function iceServerSetting(server: IceServerSetting): IceServerSetting {
  const urls: unknown = server?.urls;
  if (!Array.isArray(urls) || !urls.every((url) => typeof url === "string")) return server;
  return { ...server, urls: urls.join(", ") };
}
