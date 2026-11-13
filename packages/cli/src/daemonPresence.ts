import { STATUS_IDLE_AFTER_MS } from "@ghostly/core";
import type { GhostlyNode } from "@ghostly/browser/engine/node";
import type { EngineState } from "@ghostly/browser/shared/types";

/** How often a daemon that shares its presence says `active` again: well within the engine's 10 minutes to `idle`. */
export const PRESENCE_EVERY_MS = STATUS_IDLE_AFTER_MS / 2;

/**
 * A headless profile's presence (WISP 401 § Presence and status): off unless `settings set daemonPresence true`. On,
 * a running daemon says `active` to every paired contact whose app offers `status/1`, as a page does on input, and keeps
 * saying it while it runs; contacts see its dot. Turned off, it is taken back at once. When the daemon stops, its
 * sessions end and presence with them. A one-shot command never says it: it is gone a moment later.
 */
export class DaemonPresence {
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(private readonly node: Pick<GhostlyNode, "setPresence">) {}

  /** Follows the setting in each state the engine draws. */
  check(state: EngineState): void {
    const on = state.settings.daemonPresence === true;
    if (on === (this.timer !== undefined)) return;
    if (!on) {
      this.stop();
      this.node.setPresence({ presence: null });
      return;
    }
    this.node.setPresence({ presence: "active" });
    this.timer = setInterval(() => this.node.setPresence({ presence: "active" }), PRESENCE_EVERY_MS);
    this.timer.unref?.();
  }

  stop(): void {
    clearInterval(this.timer);
    this.timer = undefined;
  }
}
