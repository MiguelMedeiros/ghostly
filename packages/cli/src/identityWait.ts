import type { GhostlyEvent } from "./events";

/**
 * What `identity add` writes on stderr while an in-app signer waits: only the events of its own call (`request`, the
 * id it gave `identity.add`), never another proof's waiting on the same daemon. On a terminal in words, as every
 * other wait (`ghostly: …`), the link or code on its own line; on a pipe the event's JSON line. An event with no
 * `request` comes from a daemon older than the id (not restarted since an upgrade): told, as it was before, since
 * without it the link to approve on never shows and the proof waits out its --timeout.
 */
export function identityWaitLines(event: GhostlyEvent, request: string, terminal: boolean): string {
  if ((event.type !== "identity.approval" && event.type !== "identity.progress") || (event.request !== undefined && event.request !== request)) return "";
  if (!terminal) return JSON.stringify(event) + "\n";
  if (event.type === "identity.progress") return `ghostly: ${String(event.message)}\n`;
  const lines: string[] = [];
  if (typeof event.url === "string") lines.push("ghostly: Approve the request at this link:", event.url);
  // The app's caption sits beside its button ("Or scan with Pubky Ring"): the CLI has no button.
  if (typeof event.qr === "string") lines.push(`ghostly: Approve the request with this code${typeof event.label === "string" ? ` (${event.label.replace(/^Or (\w)/, (_, c: string) => c.toUpperCase())})` : ""}:`, event.qr);
  for (const note of Array.isArray(event.notes) ? event.notes : []) lines.push(`ghostly: ${String(note)}`);
  return lines.map((line) => line + "\n").join("");
}
