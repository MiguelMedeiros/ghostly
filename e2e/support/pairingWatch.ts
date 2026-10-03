import type { BrowserContext, Page } from "@playwright/test";

/**
 * What a pairing shows, at every change of the page, however brief: the scene (its stage, step and words), the
 * connection icon and the chat list. Polling from the test would miss a frame where something blanks and comes back;
 * a MutationObserver sees every commit. Installed before the app loads, so a reload starts a new record.
 */
export interface PairingFrame {
  /** ms since the page started. */
  t: number;
  scene: boolean;
  stage?: string;
  step?: number;
  leaving: boolean;
  label: string;
  /** The connection icon: its kind (`data-state`) and the pairing stage it tells (`data-pairing`). */
  icon?: string;
  iconPairing?: string;
  /** The chat list's rows, as text. */
  rows: string;
  composer: boolean;
}

export async function watchPairing(context: BrowserContext): Promise<void> {
  await context.addInitScript(() => {
    const frames: unknown[] = [];
    (window as unknown as { qaPairingFrames: unknown[] }).qaPairingFrames = frames;
    const t0 = performance.now();
    let last = "";
    const text = (element: Element | null | undefined) => ((element as HTMLElement | null)?.innerText ?? "").replace(/\s+/g, " ").trim();
    const look = () => {
      const scene = document.querySelector("[data-testid=pairing-scene]");
      const icon = document.querySelector("[data-testid=connection-options]");
      const step = scene?.getAttribute("data-step");
      const frame = {
        scene: !!scene,
        stage: scene?.getAttribute("data-stage") ?? undefined,
        step: step == null ? undefined : Number(step),
        leaving: !!scene?.hasAttribute("data-leaving"),
        label: text(scene?.querySelector("[data-testid=pairing-stage-label]")),
        icon: icon?.getAttribute("data-state") ?? undefined,
        iconPairing: icon?.getAttribute("data-pairing") ?? undefined,
        rows: [...document.querySelectorAll("[data-testid=chat-row]")].map(text).join(" | "),
        composer: !!document.querySelector("[placeholder='Message…']:not([disabled])"),
      };
      const key = JSON.stringify(frame);
      if (key === last) return;
      last = key;
      frames.push({ t: Math.round(performance.now() - t0), ...frame });
    };
    const start = () => {
      new MutationObserver(look).observe(document.documentElement, { subtree: true, childList: true, attributes: true, characterData: true });
      look();
    };
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start); else start();
  });
}

export const pairingFrames = (page: Page): Promise<PairingFrame[]> =>
  page.evaluate(() => (window as unknown as { qaPairingFrames: PairingFrame[] }).qaPairingFrames);

/** Every way the record breaks the rules of a smooth pairing, in words; none for a smooth one. */
export function pairingGlitches(frames: PairingFrame[], { leaveWithinMs }: { leaveWithinMs: number }): string[] {
  const glitches: string[] = [];
  const at = (f: PairingFrame) => `at ${f.t} ms`;
  let shown = false, gone = false, step = -1, rowsSeen = false, liveAt: number | undefined;
  for (const f of frames) {
    if (f.scene) {
      // On screen once, from its first stage to its end: it never leaves and comes back.
      if (gone) glitches.push(`the scene came back ${at(f)} (${f.stage})`);
      shown = true;
      if (!f.label) glitches.push(`the scene's words were empty ${at(f)}`);
      if (f.step !== undefined && f.step < step) glitches.push(`the step went back from ${step} to ${f.step} ${at(f)}`);
      if (f.step !== undefined) step = Math.max(step, f.step);
      // While it walks its steps the icon tells the same pairing, not the DHT nor a connection of its own.
      if (f.stage !== "live" && f.stage !== "failed" && (f.iconPairing !== f.stage || f.icon !== "waiting"))
        glitches.push(`the icon said ${f.icon}/${f.iconPairing} while the scene said ${f.stage} ${at(f)}`);
    } else if (shown) gone = true;
    if (f.rows) rowsSeen = true;
    else if (rowsSeen) glitches.push(`the chat list went empty ${at(f)}`);
    if (liveAt === undefined && f.icon === "connected") liveAt = f.t;
  }
  // It ends once the chat is live, and soon after; or once the chat is on the DHT (usable, and the icon says so).
  const end = frames.find((f, i) => i > 0 && !f.scene && frames[i - 1].scene);
  if (shown && end?.icon === "dht") return glitches;
  if (shown) {
    if (liveAt === undefined) glitches.push("the chat never went live");
    else if (!end) glitches.push("the scene never ended");
    else if (end.t < liveAt) glitches.push(`the scene ended ${liveAt - end.t} ms before the chat was live`);
    else if (end.t - liveAt > leaveWithinMs) glitches.push(`the scene ended ${end.t - liveAt} ms after the chat was live`);
  }
  return glitches;
}
