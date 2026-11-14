import { Profiler } from "react";
import { act, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { MessageBubble } from "../../components/MessageBubble";
import { setAppOpener } from "../../lib/apps/open";
import { forgetAppsAvailable, RUNNER_RETRY_MS } from "../../lib/apps/flag";
import { forgetInstalledApps } from "../../lib/apps/installed";
import { runnerPolicy } from "../../lib/apps/runnerCheck";
import type { ChatMessage } from "../../lib/types";
import { fakeEngine, linkView } from "../fakeEngine";
import { renderApp } from "../render";

// covers: apps.web-sandbox

/**
 * Every message bubble asks whether Apps shows (an app card or its text). While the runner page cannot be asked (the
 * web app opened offline), it is asked again every RUNNER_RETRY_MS and at each `online` event: an answer that is still
 * "cannot be asked" changes nothing a bubble shows, so no bubble is drawn again.
 */

vi.mock("../../lib/apps/runnerCheck", () => ({ runnerAvailable: vi.fn(async () => false), runnerPolicy: vi.fn(async () => null), forgetRunnerCheck: () => {}, isRunnerPolicy: () => true }));

const text = (i: number): ChatMessage => ({ id: `m${i}`, text: `message ${i}`, sender: i % 2 ? "peer" : "me", timestamp: 1_700_000_000_000 + i });

beforeEach(() => {
  forgetAppsAvailable();
  forgetInstalledApps();
  vi.stubEnv("VITE_APPS_TEST", "1");
  fakeEngine.appRunner = "/app-frame.html";
  setAppOpener(vi.fn(async () => {}));
  fakeEngine.on("appList", () => []);
  fakeEngine.setState({ links: [linkView({ id: "link-1", peerPubKeyZ32: "peer", profile: "paired-chat/1" })] });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  setAppOpener(null);
  forgetAppsAvailable();
});

it("draws no bubble again while the runner page still cannot be asked", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  let draws = 0;
  renderApp(<Profiler id="chat" onRender={() => { draws++; }}>
    {Array.from({ length: 50 }, (_, i) => <MessageBubble key={i} message={text(i)} peerPubKey="peer" contactName="Ana" linkId="link-1" />)}
  </Profiler>);
  expect(screen.getAllByText(/^message \d+$/)).toHaveLength(50);
  // The first check's answer: "cannot be asked" now.
  await act(async () => {});
  expect(vi.mocked(runnerPolicy)).toHaveBeenCalledTimes(1);
  const before = draws;
  for (let i = 0; i < 4; i++) await act(async () => { await vi.advanceTimersByTimeAsync(RUNNER_RETRY_MS); });
  await act(async () => { window.dispatchEvent(new Event("online")); });
  await act(async () => {});
  expect(vi.mocked(runnerPolicy).mock.calls.length).toBeGreaterThanOrEqual(5);
  expect(draws - before).toBe(0);
});
