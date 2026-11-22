import { Profiler } from "react";
import { act, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { InstalledAppView } from "@ghostly/browser/engine/apps";
import { MessageBubble } from "../../components/MessageBubble";
import { setAppOpener } from "../../lib/apps/open";
import { forgetAppsAvailable } from "../../lib/apps/flag";
import { forgetInstalledApps, installedApps, refreshInstalledApps } from "../../lib/apps/installed";
import type { ChatMessage } from "../../lib/types";
import { fakeEngine, linkView } from "../fakeEngine";
import { renderApp } from "../render";

// covers: apps.chat.card

/**
 * The engine says the update check ran (`apps-checked`) at every Apps page visit, in every tab, and the installed apps
 * are read again for it. A read that finds them as they were draws no app card again; one that finds an app changed
 * draws only the cards of that app.
 */

vi.mock("../../lib/apps/runnerCheck", () => ({ runnerAvailable: vi.fn(async () => true), runnerPolicy: vi.fn(async () => true), forgetRunnerCheck: () => {}, isRunnerPolicy: () => true }));

const KEY = "yz7moxucbd4u8aqtf5xg1hpw3nkjie9rsadc6lm2vbe4ytq5hwro";
const refOf = (n: number) => `${KEY}/app${n}`;
const installed = (n: number, version = "1.0.0"): InstalledAppView => ({
  ref: refOf(n), name: `app${n}`, publisher: KEY, fingerprint: "yz7m oxuc bd4u 8aqt", title: `App ${n}`, tagline: "A game", version,
  sequence: 1, digest: `digest-${n}`, permissions: ["chat"], view: "chat", from: `https://raw.githubusercontent.com/ana/app${n}/HEAD/app.ghostlyapp`,
  icon: false, installedAt: n, updatedAt: n, run: { status: "ok" }, listedBy: [], unknownPublisher: true,
});
// Every 5th message is an app card: of app 0, 1 or 2 (installed), or of app 3 (not installed here).
const message = (i: number): ChatMessage => ({
  id: `m${i}`, text: `message ${i}`, sender: i % 2 ? "peer" : "me", timestamp: 1_700_000_000_000 + i,
  ...(i % 5 === 0 && { card: { kind: "app" as const, id: `app:${refOf((i / 5) % 4)}`, ref: refOf((i / 5) % 4), digest: `digest-${(i / 5) % 4}`, sequence: 1, title: `App ${(i / 5) % 4}` } }),
});

let list: InstalledAppView[];
beforeEach(() => {
  forgetAppsAvailable();
  forgetInstalledApps();
  vi.stubEnv("VITE_APPS_TEST", "1");
  fakeEngine.appRunner = "/app-frame.html";
  setAppOpener(vi.fn(async () => {}));
  list = [installed(0), installed(1), installed(2)];
  // A new array of new objects at each read, as the engine's answer over its channel is.
  fakeEngine.on("appList", () => structuredClone(list)).on("appBuiltIns", () => []);
  fakeEngine.setState({ links: [linkView({ id: "link-1", peerPubKeyZ32: "peer", profile: "paired-chat/1" })] });
});
afterEach(() => {
  vi.unstubAllEnvs();
  setAppOpener(null);
  forgetAppsAvailable();
  forgetInstalledApps();
});

it("draws no app card again after a check that changed nothing, and only an updated app's cards after one that did", async () => {
  const draws = new Map<number, number>();
  renderApp(<>{Array.from({ length: 40 }, (_, i) => (
    <Profiler key={i} id={`m${i}`} onRender={() => { draws.set(i, (draws.get(i) ?? 0) + 1); }}>
      <MessageBubble message={message(i)} peerPubKey="peer" contactName="Ana" linkId="link-1" />
    </Profiler>
  ))}</>);
  await act(async () => {});
  expect(screen.getAllByText(/^message \d+$/).length).toBeGreaterThan(0);
  expect(fakeEngine.callsTo("appList")).toHaveLength(1);
  const redrawn = (before: Map<number, number>) => [...draws].filter(([i, n]) => n > (before.get(i) ?? 0)).map(([i]) => i);

  let before = new Map(draws);
  for (let check = 0; check < 3; check++) await act(async () => { fakeEngine.emit({ kind: "apps-checked" }); });
  expect(fakeEngine.callsTo("appList")).toHaveLength(4);
  expect(redrawn(before), "nothing changed: no bubble drawn again").toEqual([]);

  // App 1 updated: its cards (messages 5 and 25) say its new version; the others are not drawn again.
  list = [installed(0), installed(1, "1.1.0"), installed(2)];
  before = new Map(draws);
  await act(async () => { fakeEngine.emit({ kind: "apps-checked" }); });
  expect(redrawn(before)).toEqual([5, 25]);
});

// A check that finds nothing new still stamps a new `checkedAt` on every installed app (the engine's view carries it),
// and nothing in the UI reads it: the apps read as before.
const checked = (n: number, at: number): InstalledAppView => ({ ...installed(n), checkedAt: at });

it("keeps every installed app's object when a check moved only its checkedAt", async () => {
  list = [installed(0), installed(1)];
  await refreshInstalledApps();
  const first = installedApps();
  expect(first).toHaveLength(2);

  // The first check stamps a checkedAt the apps had none of, the next one moves it.
  for (const at of [1_700_000_000_000, 1_700_000_000_000 + 31 * 60_000]) {
    list = [checked(0, at), checked(1, at)];
    await refreshInstalledApps();
    expect(installedApps(), `checkedAt ${at}: the list held`).toBe(first);
  }

  // Anything else that moved is a new object, and only that app's.
  list = [checked(0, 1), { ...checked(1, 1), version: "1.1.0" }];
  await refreshInstalledApps();
  const after = installedApps();
  expect(after).not.toBe(first);
  expect(after?.[0]).toBe(first?.[0]);
  expect(after?.[1]).not.toBe(first?.[1]);
  expect(after?.[1]?.version).toBe("1.1.0");
});

it("draws no app card again after a check that moved only every app's checkedAt", async () => {
  const draws = new Map<number, number>();
  renderApp(<>{Array.from({ length: 40 }, (_, i) => (
    <Profiler key={i} id={`m${i}`} onRender={() => { draws.set(i, (draws.get(i) ?? 0) + 1); }}>
      <MessageBubble message={message(i)} peerPubKey="peer" contactName="Ana" linkId="link-1" />
    </Profiler>
  ))}</>);
  await act(async () => {});
  expect(fakeEngine.callsTo("appList")).toHaveLength(1);
  const before = new Map(draws);
  for (const at of [1_700_000_000_000, 1_700_000_000_000 + 31 * 60_000]) {
    list = [checked(0, at), checked(1, at), checked(2, at)];
    await act(async () => { fakeEngine.emit({ kind: "apps-checked" }); });
  }
  expect(fakeEngine.callsTo("appList")).toHaveLength(3);
  expect([...draws].filter(([i, n]) => n > (before.get(i) ?? 0)).map(([i]) => i), "only checkedAt moved: no bubble drawn again").toEqual([]);
});
