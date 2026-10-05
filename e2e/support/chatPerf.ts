import { createLink } from "@ghostly/core";
import type { Page } from "@playwright/test";

/**
 * Measuring a chat's open (web/chat-open-perf.spec.ts): a seeded history of every kind of message, and the numbers
 * from the click on the chat's row to the list settled at its bottom.
 */

export interface Open {
  /** Click to the first message row painted, in ms. */
  paint: number;
  /** Click to the first frame with the list at its bottom. */
  bottom: number;
  /** Click to the list at its bottom and still for a quarter of a second: every row in the page, laid out. */
  settled: number;
  /** Changes of size between `bottom` and the settle that left the view off the bottom: the view jumping. */
  offBottom: number;
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
  /** Coming from another chat: its message rows in the page at the click. */
  before: number;
}

/** A tiny JPEG, as a link preview's thumbnail carries one. */
const THUMB = "data:image/jpeg;base64,/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=";

/**
 * A chat's history, as the app keeps it in localStorage: `count` messages of every kind a chat shows. `lean` makes the
 * long texts and previews shorter, so that 20,000 messages still fit in the page's storage.
 */
export function history(count: number, start: number, lean = false) {
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
      base.preview = { u: `https://example.com/post/${i}`, t: `Post ${i}: ${line(i, 5)}`, d: line(i + 3, lean ? 3 : 14), s: "Example", ...(i % 20 === 1 && { i: THUMB }) };
    } else if (kind === 2) text = `https://web.archive.org/web/2009/http://geocities.com/ghost${i}.gif`;
    else if (kind === 3 && i % 30 === 3) {
      text = "";
      base.file = { id: `voice-${i}`, name: `voice-${i}.webm`, size: 40_000, mime: "audio/webm", voice: { duration: 4_000 + i, peaks: Array.from({ length: 48 }, (_, k) => (i * 13 + k * 29) % 256) } };
    } else if (kind === 4 && i % 40 === 4) {
      text = "";
      base.file = { id: `video-${i}`, name: `ghosts-${i}.mp4`, size: 900_000, mime: "video/mp4", video: { duration: 6_000, width: 640, height: 360 } };
    } else if (kind === 3 && i % 30 === 13) {
      text = "";
      base.file = { id: `picture-${i}`, name: `moon-${i}.jpg`, size: 120_000, mime: "image/jpeg", image: { width: 800, height: 600 } };
    } else if (kind === 5) text = i % 20 === 5 ? (lean ? `${line(i, 8)}\n${line(i + 1, 6)}` : `${line(i, 30)}\n${line(i + 1, 25)}\n${line(i + 2, 12)}`) : line(i, 6);
    else if (i % 60 === 28) {
      // A bot's task card (WISP 405 · Status Cards), its text the fallback.
      const status = (["running", "done", "failed", "blocked"] as const)[(i / 60 | 0) % 4];
      base.card = {
        kind: "task", id: `task-${i}`, title: `Task ${i}: ${line(i, 4)}`, status, progress: (i * 7) % 100, step: line(i + 1, 5),
        pr: { url: `https://github.com/o/r/pull/${i}`, number: i, additions: i % 300, deletions: i % 70 },
        items: Array.from({ length: 4 }, (_, k) => ({ text: line(i + k, 4), state: (["done", "running", "pending", "done"] as const)[k] })),
        updatedAt: start + i * 45_000,
      };
      text = `Task ${i}: ${status}`;
    } else if (i % 60 === 58 || i % 60 === 59) {
      // A routine's report, and another right after it: a stack of routine cards.
      base.card = {
        kind: "routine", id: `routine-${i % 2}`, name: `Daily report ${i % 2}`, schedule: "every day 01:00", state: "active",
        lastRun: { at: start + i * 45_000, result: i % 180 === 58 ? "failed" : "ok", summary: line(i, 6) }, nextRunAt: start + i * 45_000 + 86_400_000,
      };
      text = `Daily report ${i % 2}`;
    } else text = line(i, 3 + (i % 9));
    base.text = text;
    // Replies to a message a little earlier, reactions, edits and forwards, spread over the kinds.
    if (i > 10 && i % 7 === 5) {
      const to = i - 1 - (i % 9);
      const original = `r${String(to).padStart(6, "0")}ab`;
      base.replyTo = { id: original, snippet: line(to, 4), from: to % 3 === 0 ? "me" : "peer", messageId: to % 3 === 0 ? `me_${original}` : `peer_${original}` };
    }
    // The last message quotes the first: a jump from the bottom to the top of the history.
    if (i === count - 1 && count > 1) base.replyTo = { id: "r000000ab", snippet: line(0, 4), from: "me", messageId: "me_r000000ab" };
    if (i % 6 === 0) base.reactions = { peer: { e: "❤️", n: 1, at: start + i * 45_000 + 1_000 }, ...(i % 12 === 0 && { me: { e: "😂", n: 1, at: start + i * 45_000 + 2_000 } }) };
    if (mine && kind >= 5 && i % 15 === 6) base.edit = { seq: 1, at: start + i * 45_000 + 5_000, history: [{ at: start + i * 45_000, text: `${text} (first)` }] };
    if (!mine && kind >= 5 && i % 20 === 7) base.forwarded = i % 40 === 7 ? 5 : 1;
    return base;
  });
}

/** Stores the chats and returns their ids: the chat list shows them by their labels. */
export async function seed(page: Page, chats: { label: string; count: number; lean?: boolean }[]): Promise<string[]> {
  const start = Date.now() - 30 * 86_400_000;
  const stored = chats.map(({ label, count, lean }) => {
    const keys = createLink().mine;
    return { label, keys, messages: history(count, start, lean) };
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

/**
 * Writes `count` messages (as `history` makes them, from the same start as `seed`) into the engine's own store for the
 * chat labelled `label`, as if they had come over time: a history the engine keeps, which a reload brings to the page.
 * The chat's link must come (the page asks the engine for it once the chat is stored): this waits for it.
 */
export async function engineHistory(page: Page, label: string, count: number): Promise<void> {
  const rows = history(count, Date.now() - 30 * 86_400_000).map(({ ref: _ref, ...m }) => ({ ...m, via: "datalink" }));
  await page.evaluate(async ({ label, rows }) => {
    const session = Object.keys(localStorage).map(k => { try { return JSON.parse(localStorage.getItem(k)!); } catch { return null; } }).find(s => s?.label === label);
    const open = () => new Promise<IDBDatabase>((ok, ko) => { const r = indexedDB.open("ghostly"); r.onsuccess = () => ok(r.result); r.onerror = () => ko(r.error); });
    let linkId: string | undefined;
    for (let i = 0; i < 300 && !linkId; i++) {
      const db = await open();
      const links = db.objectStoreNames.contains("links")
        ? await new Promise<{ id: string; peerPubKeyZ32: string }[]>(ok => { const r = db.transaction("links").objectStore("links").getAll(); r.onsuccess = () => ok(r.result); })
        : [];
      db.close();
      linkId = links.find(l => l.peerPubKeyZ32 === session?.peerPubKeyB64)?.id;
      if (!linkId) await new Promise(r => setTimeout(r, 100));
    }
    if (!linkId) throw new Error(`no link for ${label}`);
    const db = await open();
    const tx = db.transaction("messages", "readwrite");
    for (const row of rows) tx.objectStore("messages").put({ ...row, linkId });
    await new Promise((ok, ko) => { tx.oncomplete = ok; tx.onerror = () => ko(tx.error); });
    db.close();
  }, { label, rows });
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
  // Coming from another chat: its list stays in the page until the new one takes its place.
  const previous = document.querySelector<HTMLElement>(".chat-wallpaper");
  const before = previous?.querySelectorAll("[data-message-row]").length ?? 0;
  const t0 = performance.now();
  row.click();
  return (async () => {
    let paint = 0, settled = 0, still = 0, last = "", atBottom = 0, offBottom = 0;
    let watcher: ResizeObserver | undefined;
    const list = () => [...document.querySelectorAll<HTMLElement>(".chat-wallpaper")].find(el => el !== previous) ?? null;
    while (performance.now() - t0 < 120_000) {
      const now = await afterPaint();
      const el = list();
      if (!paint && el?.querySelector("[data-message-row]")) paint = now - t0;
      if (!paint || !el) continue;
      const at = `${el.scrollTop}|${el.scrollHeight}|${el.clientHeight}`;
      const bottom = el.scrollHeight - el.scrollTop - el.clientHeight <= 2;
      if (bottom && !atBottom) {
        atBottom = now - t0;
        // From then on, each time the list or its rows change size, where the view is once the app has settled it (this
        // observer is called after the app's own, which was made first) and before that frame is painted.
        watcher = new ResizeObserver(() => { if (el.scrollHeight - el.scrollTop - el.clientHeight > 2) offBottom++; });
        watcher.observe(el);
        if (el.firstElementChild) watcher.observe(el.firstElementChild);
      }
      if (bottom && at === last) {
        // Still for a quarter of a second: settled when it last moved.
        if (still && now - t0 - settled >= 250) break;
        if (!still) { still = 1; settled = now - t0; }
      } else { still = 0; settled = 0; }
      last = at;
    }
    watcher?.disconnect();
    const commitsSettled = w.__ghostlyCommits - commits0;
    const idleFrom = performance.now();
    await new Promise(done => setTimeout(done, 2_000));
    observer.disconnect();
    const inWindow = long.filter(e => e.startTime >= t0 - 5 && e.startTime <= t0 + settled);
    const idle = long.filter(e => e.startTime >= idleFrom);
    return {
      paint: Math.round(paint), bottom: Math.round(atBottom), settled: Math.round(settled), offBottom,
      longTasks: inWindow.length, longTotal: Math.round(inWindow.reduce((s, e) => s + e.duration, 0)), longMax: Math.round(Math.max(0, ...inWindow.map(e => e.duration))),
      commits: commitsSettled, rows: document.querySelectorAll(".chat-wallpaper [data-message-row]").length,
      idleLong: Math.round(idle.reduce((s, e) => s + e.duration, 0)), idleCommits: w.__ghostlyCommits - commits0 - commitsSettled, before,
    };
  })();
}

export const median = (values: number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
export const summary = (opens: Open[]) => Object.fromEntries((Object.keys(opens[0]) as (keyof Open)[]).map(k => [k, median(opens.map(o => o[k]))])) as unknown as Open;

