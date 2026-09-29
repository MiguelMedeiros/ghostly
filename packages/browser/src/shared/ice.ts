import type { IceServerSetting } from "./types";

/**
 * What is wrong with a TURN/STUN server, or null. Browsers refuse to create any WebRTC connection when
 * one server in the list is malformed, so a bad entry here would silently cut off calls and files.
 */
export function iceServerProblem(server: IceServerSetting): string | null {
  const urls = server.urls.split(/[\s,]+/).filter(Boolean);
  if (!urls.length) return "Enter the TURN server address";
  for (const url of urls) {
    if (!/^(stun|turns?):[^\s/?#]+(\?transport=(udp|tcp))?$/i.test(url)) return `“${url}” is not a TURN or STUN address (turn:host:port)`;
    if (/^turns?:/i.test(url) && (!server.username?.trim() || !server.credential?.trim())) return "A TURN server needs its username and credential";
  }
  return null;
}
