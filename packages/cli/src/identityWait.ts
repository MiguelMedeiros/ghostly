import type { GhostlyEvent } from "./events";

/**
 * What `identity add` writes on stderr while an in-app signer waits: only the events of its own call (`request`, the
 * id it gave `identity.add`), never another proof's waiting on the same daemon. One naming no request is said too: a
 * daemon started before an upgrade takes `request` and does not say it back, and dropping its events hid the only link
 * or code to approve with. On a terminal in words, as every other wait (`ghostly: …`), the link or code on its own
 * line; on a pipe the event's JSON line.
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
