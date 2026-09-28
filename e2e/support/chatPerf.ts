import { createLink } from "@ghostly/core";
import type { Page } from "@playwright/test";

/**
 * Measuring a chat's open (web/chat-open-perf.spec.ts): a seeded history of every kind of message, and the numbers
 * from the click on the chat's row to the list settled at its bottom.
 */

export interface Open {
  /** Click to the first message row painted, in ms. */
  paint: number;
  /** Click to the list at its bottom and still for a quarter of a second. */
  settled: number;
  /** Long tasks (over 50 ms) between the click and the settle: how many, their total and the longest. */
  longTasks: number;
  longTotal: number;
  longMax: number;
  /** React commits between the click and the settle. */
  commits: number;
  /** Message rows in the page once settled. */
  rows: number;
  /** The open chat left alone for two seconds after the settle: long tasks' total, and React commits. */
  idleLong: number;
  idleCommits: number;
}

/** A tiny JPEG, as a link preview's thumbnail carries one. */
const THUMB = "data:image/jpeg;base64,/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=";

/** A chat's history, as the app keeps it in localStorage: `count` messages of every kind a chat shows. */
export function history(count: number, start: number) {
  const words = ["ghost", "boo", "lantern", "attic", "whisper", "moonlight", "cobweb", "candle", "haunt", "echo"];
  const line = (i: number, n: number) => Array.from({ length: n }, (_, k) => words[(i * 7 + k * 3) % words.length]).join(" ");
  return Array.from({ length: count }, (_, i) => {
    const mine = i % 3 === 0;
    const ref = `r${String(i).padStart(6, "0")}ab`;
    const base: Record<string, unknown> = {
      id: mine ? `me_${ref}` : `peer_${ref}`, ref, sender: mine ? "me" : "peer", timestamp: start + i * 45_000,
      ...(mine && { delivery: "delivered" }),
    };
    const kind = i % 10;
    let text: string;
    if (kind === 0) text = `*${line(i, 2)}* and _${line(i + 1, 2)}_ with \`code ${i}\`\n- ${line(i, 3)}\n- ${line(i + 2, 4)}`;
    else if (kind === 1) {
      text = `Look at https://example.com/post/${i}?utm_source=x ${line(i, 4)}`;
      base.preview = { u: `https://example.com/post/${i}`, t: `Post ${i}: ${line(i, 5)}`, d: line(i + 3, 14), s: "Example", ...(i % 20 === 1 && { i: THUMB }) };
    } else if (kind === 2) text = `https://web.archive.org/web/2009/http://geocities.com/ghost${i}.gif`;
    else if (kind === 3 && i % 30 === 3) {
      text = "";
      base.file = { id: `voice-${i}`, name: `voice-${i}.webm`, size: 40_000, mime: "audio/webm", voice: { duration: 4_000 + i, peaks: Array.from({ length: 48 }, (_, k) => (i * 13 + k * 29) % 256) } };
    } else if (kind === 4 && i % 40 === 4) {
      text = "";
      base.file = { id: `video-${i}`, name: `ghosts-${i}.mp4`, size: 900_000, mime: "video/mp4", video: { duration: 6_000, width: 640, height: 360 } };
    } else if (kind === 5) text = i % 20 === 5 ? `${line(i, 30)}\n${line(i + 1, 25)}\n${line(i + 2, 12)}` : line(i, 6);
    else text = line(i, 3 + (i % 9));
    base.text = text;
    // Replies to a message a little earlier, reactions, edits and forwards, spread over the kinds.
    if (i > 10 && i % 7 === 5) {
      const to = i - 1 - (i % 9);
      const original = `r${String(to).padStart(6, "0")}ab`;
      base.replyTo = { id: original, snippet: line(to, 4), from: to % 3 === 0 ? "me" : "peer", messageId: to % 3 === 0 ? `me_${original}` : `peer_${original}` };
    }
    if (i % 6 === 0) base.reactions = { peer: { e: "❤️", n: 1, at: start + i * 45_000 + 1_000 }, ...(i % 12 === 0 && { me: { e: "😂", n: 1, at: start + i * 45_000 + 2_000 } }) };
    if (mine && kind >= 5 && i % 15 === 6) base.edit = { seq: 1, at: start + i * 45_000 + 5_000, history: [{ at: start + i * 45_000, text: `${text} (first)` }] };
    if (!mine && kind >= 5 && i % 20 === 7) base.forwarded = i % 40 === 7 ? 5 : 1;
    return base;
  });
}

/** Stores the chats and returns their ids: the chat list shows them by their labels. */
export async function seed(page: Page, chats: { label: string; count: number }[]): Promise<string[]> {
  const start = Date.now() - 30 * 86_400_000;
  const stored = chats.map(({ label, count }) => {
    const keys = createLink().mine;
    return { label, keys, messages: history(count, start) };
  });
  const ids = await page.evaluate(stored => stored.map(({ label, keys, messages }) => {
    const id = crypto.randomUUID().replaceAll("-", "");
    localStorage.setItem(`ghostly_${id}`, JSON.stringify({
      id, profile: "paired-chat/1", mySeedB64: keys.seedB64, peerPubKeyB64: keys.peerPubKeyZ32, encKeyB64: keys.encKeyB64,
      label, messages, createdAt: (messages[0] as { timestamp: number }).timestamp,
    }));
    return id;
  }), stored);
  await page.evaluate(() => window.dispatchEvent(new Event("session-updated")));
  return ids;
}

/** Counts React's commits: React calls the DevTools hook on each, in a production build too. */
export function countCommits() {
  const w = window as unknown as { __REACT_DEVTOOLS_GLOBAL_HOOK__?: unknown; __ghostlyCommits: number };
  w.__ghostlyCommits = 0;
  w.__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
    renderers: new Map(), supportsFiber: true, isDisabled: false,
    inject: () => 1, checkDCE: () => {}, onScheduleFiberRoot: () => {}, onCommitFiberUnmount: () => {}, onPostCommitFiberRoot: () => {},
    onCommitFiberRoot: () => { w.__ghostlyCommits++; },
  };
}

/** Opens the chat labelled `label` from the chat list, in the page, and measures it (see `Open`). */
export function openAndMeasure(label: string): Promise<Open> {
  const w = window as unknown as { __ghostlyCommits: number };
  const row = [...document.querySelectorAll<HTMLElement>("[data-testid=chat-row]")].find(r => r.querySelector("[data-testid=chat-row-name]")?.textContent === label);
  if (!row) throw new Error(`no chat row ${label}`);
  const long: PerformanceEntry[] = [];
  const observer = new PerformanceObserver(list => long.push(...list.getEntries()));
  observer.observe({ type: "longtask" });
  const afterPaint = () => new Promise<number>(done => requestAnimationFrame(() => {
    const channel = new MessageChannel();
    channel.port1.onmessage = () => done(performance.now());
    channel.port2.postMessage(0);
  }));
  const commits0 = w.__ghostlyCommits;
  const t0 = performance.now();
  row.click();
  return (async () => {
    let paint = 0, settled = 0, still = 0, last = "";
    const list = () => document.querySelector<HTMLElement>(".chat-wallpaper");
    while (performance.now() - t0 < 30_000) {
      const now = await afterPaint();
      const el = list();
      if (!paint && el?.querySelector("[data-message-row]")) paint = now - t0;
      if (!paint || !el) continue;
      const at = `${el.scrollTop}|${el.scrollHeight}|${el.clientHeight}`;
      const bottom = el.scrollHeight - el.scrollTop - el.clientHeight <= 2;
      if (bottom && at === last) {
        // Still for a quarter of a second: settled when it last moved.
        if (still && now - t0 - settled >= 250) break;
        if (!still) { still = 1; settled = now - t0; }
      } else { still = 0; settled = 0; }
      last = at;
    }
    const commitsSettled = w.__ghostlyCommits - commits0;
    const idleFrom = performance.now();
    await new Promise(done => setTimeout(done, 2_000));
    observer.disconnect();
    const inWindow = long.filter(e => e.startTime >= t0 - 5 && e.startTime <= t0 + settled);
    const idle = long.filter(e => e.startTime >= idleFrom);
    return {
      paint: Math.round(paint), settled: Math.round(settled),
      longTasks: inWindow.length, longTotal: Math.round(inWindow.reduce((s, e) => s + e.duration, 0)), longMax: Math.round(Math.max(0, ...inWindow.map(e => e.duration))),
      commits: commitsSettled, rows: document.querySelectorAll(".chat-wallpaper [data-message-row]").length,
      idleLong: Math.round(idle.reduce((s, e) => s + e.duration, 0)), idleCommits: w.__ghostlyCommits - commits0 - commitsSettled,
    };
  })();
}

export const median = (values: number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
export const summary = (opens: Open[]) => Object.fromEntries((Object.keys(opens[0]) as (keyof Open)[]).map(k => [k, median(opens.map(o => o[k]))])) as unknown as Open;

