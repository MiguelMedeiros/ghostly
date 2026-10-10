/**
 * A counter two people share in a chat: each click adds one on both sides. It uses every part of
 * `@ghostlytools/sdk/app` an app needs: `window.ghostly`, its storage and chat, the refusal codes and the limits.
 */
import { MINI_APP_LIMITS, miniAppErrorCode, type MiniAppApi, type MiniAppErrorCode, type MiniAppJson } from "@ghostlytools/sdk/app";

declare global {
  interface Window { ghostly: MiniAppApi }
}

const ghostly = window.ghostly;
let count = 0;

/** What to show for a refused send. A code this app does not know (a later client may add one) reads as `failed`. */
export function sendProblem(code: MiniAppErrorCode | null): string {
  switch (code) {
    case "offline": return "Waiting for you both to be online";
    case "peer-closed": return "Waiting for your contact to open the counter";
    case "too-fast": return "Slow down";
    case null: return "Something went wrong";
    default: return `Not sent (${code})`;
  }
}

async function bump(): Promise<void> {
  count += 1;
  await ghostly.storage.set("count", count);
  const frame: MiniAppJson = { count };
  if (new TextEncoder().encode(JSON.stringify(frame)).length > MINI_APP_LIMITS.chatDataBytes) return;
  try {
    await ghostly.chat.send(frame);
  } catch (error) {
    document.title = sendProblem(miniAppErrorCode(error));
  }
}

async function start(): Promise<void> {
  const context = await ghostly.context();
  const kept = await ghostly.storage.get("count");
  count = typeof kept === "number" ? kept : 0;
  ghostly.chat.on("message", (data) => {
    // The peer's frames are untrusted: read only what this app sends.
    if (data && typeof data === "object" && !Array.isArray(data) && typeof data.count === "number") count = Math.max(count, data.count);
  });
  const stop = ghostly.chat.on("peer", (peer) => { if (peer.open) void ghostly.chat.send({ count }).catch(() => {}); });
  document.body.dataset.theme = context.theme ?? "light";
  document.body.addEventListener("click", () => void bump());
  window.addEventListener("pagehide", stop);
}

void start();
