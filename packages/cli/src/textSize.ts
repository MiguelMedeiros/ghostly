import { LIMITS } from "@ghostly/core";
import { CliError } from "./errors";

/**
 * A text past what a chat or a group carries (16 KiB of UTF-8, as the engine counts it: trimmed) is refused before the
 * secret guard reads it and before the engine is asked, with its size and the bound, as `send` and `edit` refuse it.
 */
export function checkTextSize(text: string): void {
  const bytes = new TextEncoder().encode(text.trim()).length;
  if (bytes > LIMITS.maxChatMessageBytes) throw new CliError("bad_request", `Message exceeds ${LIMITS.maxChatMessageBytes} UTF-8 bytes (${bytes}): shorten it, or send it as a file`, { bytes, max: LIMITS.maxChatMessageBytes });
}
