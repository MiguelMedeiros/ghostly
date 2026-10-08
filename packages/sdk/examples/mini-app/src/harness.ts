/**
 * What a test harness that stands in for the broker answers, typed with `MiniAppAnswer`: a `file` read on the port
 * is an `ArrayBuffer`, Desktop's is base64 in `bytes`, and a code a later client adds still fits `error`.
 */
import type { MiniAppAnswer, MiniAppEvent } from "@ghostlytools/sdk/app";

export const answers: MiniAppAnswer[] = [
  { id: 1, ok: true, value: { count: 1 } },
  { id: 2, ok: true },
  { id: 3, ok: true, value: new ArrayBuffer(8) },
  { id: 4, ok: true, bytes: "AAAAAAAAAAA=" },
  { id: 5, ok: false, error: "offline" },
  { id: 6, ok: false, error: "a-code-from-a-later-client" },
];

export const events: MiniAppEvent[] = [
  { event: "chat.message", data: { count: 2 } },
  { event: "chat.peer", data: { open: true, version: "0.1.0" } },
];
