import { act, screen } from "@testing-library/react";
import { useState } from "react";
import { Route, Routes } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderApp } from "../render";

// covers: app.mobile-layout, app.responsive

/*
 * A phone turned on its side, or a window made wider, crosses 768px: the app goes from one screen at a time to two
 * panes. The open chat and the open page must stay mounted through it: a remount loses the message field's focus (the
 * keyboard goes down), a playing video, a chat's ↓ count and an opened card. The skip link and the <main> landmark
 * (#828) put them at another place among the page's children in each layout, and React mounted them again (#896).
 */

let mobile = false;
const listeners = new Set<() => void>();
vi.mock("../../hooks/useIsMobile", async () => {
  const { useEffect, useState } = await import("react");
  return {
    MOBILE_QUERY: "(max-width: 767px)",
    useIsMobile: () => {
      const [value, setValue] = useState(mobile);
      useEffect(() => { const on = () => setValue(mobile); listeners.add(on); return () => { listeners.delete(on); }; }, []);
      return value;
    },
  };
});

/** Each mount gets its own number, kept in its state: a remount shows another. */
let mounts = 0;
function useMountId() {
  const [id] = useState(() => ++mounts);
  return id;
}
vi.mock("../../pages/Chat", () => ({
  Chat: ({ sessionId }: { sessionId: string }) => <div data-testid="stub-chat" data-mount={useMountId()}>{sessionId}</div>,
}));
vi.mock("../../components/Sidebar", () => ({ Sidebar: () => <nav data-testid="stub-sidebar" /> }));
vi.mock("../../components/MobileTabBar", () => ({ MobileTabBar: () => null }));
vi.mock("../../components/InstallApp", () => ({ InstallSteps: () => null }));
// Desktop's menu and shortcuts need the lock screen's provider, which is not what this is about.
vi.mock("../../hooks/useAppCommands", () => ({ useAppCommands: () => {} }));

function Page() {
  return <div data-testid="stub-page" data-mount={useMountId()} />;
}

const { App } = await import("../../App");

function turn(toMobile: boolean) {
  mobile = toMobile;
  act(() => { for (const on of listeners) on(); });
}

async function mounted(testId: string) {
  return (await screen.findByTestId(testId)).dataset.mount;
}

describe("the layout switch at 768px", () => {
  afterEach(() => { mobile = false; });

  it("keeps the open chat mounted, from two panes to a phone and back", async () => {
    renderApp(<Routes><Route path="/*" element={<App />} /></Routes>, { route: "/chat/s1" });
    const first = await mounted("stub-chat");
    turn(true);
    expect(await mounted("stub-chat")).toBe(first);
    turn(false);
    expect(await mounted("stub-chat")).toBe(first);
  });

  it("keeps the open page mounted (a group, Settings), from a phone to two panes and back", async () => {
    mobile = true;
    renderApp(<Routes><Route path="/" element={<App />}><Route path="group/:id" element={<Page />} /></Route></Routes>, { route: "/group/g1" });
    const first = await mounted("stub-page");
    turn(false);
    expect(await mounted("stub-page")).toBe(first);
    turn(true);
    expect(await mounted("stub-page")).toBe(first);
  });
});
