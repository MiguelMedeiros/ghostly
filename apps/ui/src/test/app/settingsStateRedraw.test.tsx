import { Profiler } from "react";
import { act, screen } from "@testing-library/react";
import { Route, Routes } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LockScreenProvider } from "../../contexts/LockScreenContext";
import { UpdateProvider } from "../../contexts/UpdateContext";
import { setPushPlatform, type PushPlatform } from "../../lib/wakePush";
import { Settings } from "../../pages/Settings";
import { fakeEngine } from "../fakeEngine";
import { renderApp } from "../render";

// covers: settings.sections

/*
 * The engine sends its whole state anew on every change, up to 20 a second while a file moves, and Settings stays open
 * for as long as the person is in it. A state that changes nothing the page shows draws none of it: the page followed
 * the whole state for a flag that never changes (profiles) and for whether another device is woken.
 */

const wait = (ms: number) => act(() => new Promise<void>((done) => setTimeout(done, ms)));

function renderSettings(route: string) {
  const counter = { draws: 0 };
  renderApp(
    <LockScreenProvider><UpdateProvider>
      <Profiler id="settings" onRender={() => { counter.draws++; }}>
        <Routes><Route path="/settings/:section?" element={<Settings />} /></Routes>
      </Profiler>
    </UpdateProvider></LockScreenProvider>,
    { route },
  );
  return counter;
}

const transfers = () => { for (let i = 0; i < 20; i++) act(() => fakeEngine.update({ transfers: { [`t${i}`]: { bytes: i } } } as never)); };

afterEach(() => setPushPlatform(null));

describe("Settings on an engine state that changes nothing it shows", () => {
  it.each(["/settings", "/settings/network"])("is not drawn again at %s", async (route) => {
    const counter = renderSettings(route);
    await wait(300);
    counter.draws = 0;
    transfers();
    await wait(50);
    expect(counter.draws).toBe(0);
  });

  it("still shows the network's clock once it is off", async () => {
    renderSettings("/settings/network");
    await wait(300);
    expect(screen.queryByTestId("network-clock-off")).toBeNull();
    act(() => fakeEngine.update({ transport: { ...fakeEngine.state!.transport, clockOffMs: 600_000 } } as never));
    expect(await screen.findByTestId("network-clock-off")).toBeInTheDocument();
  });

  it("still says so once contacts wake another device", async () => {
    setPushPlatform({ supported: () => true, subscribe: vi.fn(), current: vi.fn(async () => null), unsubscribe: vi.fn(), syncTable: vi.fn(async () => {}) } as unknown as PushPlatform);
    renderSettings("/settings");
    await wait(300);
    expect(screen.getByTestId("settings-wake-hint")).not.toHaveTextContent("Off here");
    const wake = { endpoint: "https://push.example/phone", p256dh: "p", auth: "a", vapid: { publicKey: "v", privateKey: "k" }, device: "P".repeat(43) };
    act(() => fakeEngine.update({ settings: { ...fakeEngine.state!.settings, wake }, wakeOwner: "away" } as never));
    expect(await screen.findByText(/^Off here/)).toBeInTheDocument();
  });
});
