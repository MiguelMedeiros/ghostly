import { screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readStatusCard, type TaskCard } from "@ghostly/core";
import type { CardIndexRow } from "@ghostly/browser/shared/types";
import { LockScreenProvider } from "../../contexts/LockScreenContext";
import { UpdateProvider } from "../../contexts/UpdateContext";
import { MOBILE_QUERY } from "../../hooks/useIsMobile";
import { saveSession } from "../../lib/storage";
import { Settings } from "../../pages/Settings";
import { Tasks } from "../../pages/Tasks";
import { linkView } from "../fakeEngine";
import { renderApp } from "../render";

// covers: app.reduce-motion, chat.tasks-board, settings.sections

/** A phone or not, and the system's Reduce motion, as `matchMedia` answers them. */
function windowIs({ phone, systemReduces }: { phone: boolean; systemReduces: boolean }) {
  vi.spyOn(window, "matchMedia").mockImplementation((query) => ({
    matches: query === MOBILE_QUERY ? phone : query === "(prefers-reduced-motion: reduce)" && systemReduces,
    media: query, onchange: null, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent: () => false,
  }));
}

const viewport = (width: number, height = 800) => (window as unknown as { happyDOM: { setViewport(v: { width: number; height: number }): void } }).happyDOM.setViewport({ width, height });

afterEach(() => {
  vi.restoreAllMocks();
  viewport(1024, 768);
});

const PEER = "peerkeycoordinator";
const task = (id: string, status: string): CardIndexRow => ({
  linkId: "link-1", id: `m-${id}`, sender: "peer", timestamp: Date.now() - 60_000,
  card: readStatusCard({ kind: "task", id, title: `Task ${id}`, status }) as TaskCard,
});

function tasksOnAPhone() {
  saveSession({ id: "chat-1", profile: "paired-chat/1", mySeedB64: "c2VlZA", peerPubKeyB64: PEER, encKeyB64: "a2V5", messages: [], createdAt: 1_700_000_000_000, nick: "Coordinator" });
  viewport(375, 740);
  const rendered = renderApp(<Tasks />, { route: "/tasks" });
  rendered.engine.on("statusCardIndex", () => [task("a", "queued"), task("b", "running"), task("c", "done")])
    .setState({ links: [linkView({ id: "link-1", peerPubKeyZ32: PEER, peerNick: "Coordinator" })] });
  return rendered;
}

describe("less motion asked in either place: the app's switch or the system's", () => {
  it("a tab on the phone's Tasks board jumps to its column when the app's Reduce motion switch is on", async () => {
    windowIs({ phone: true, systemReduces: false });
    // Settings → Reduce motion, as the app keeps it.
    localStorage.setItem("ghostly_app_settings", JSON.stringify({ reduceMotion: true }));
    const { user } = tasksOnAPhone();
    expect(document.documentElement.dataset.reduceMotion).toBe("true");
    await waitFor(() => expect(screen.getByTestId("tasks-board")).toHaveAttribute("data-layout", "tabs"));
    const board = screen.getByTestId("tasks-board");
    const scrollTo = vi.fn();
    board.scrollTo = scrollTo as typeof board.scrollTo;
    await user.click(within(screen.getByRole("tablist", { name: "Columns" })).getAllByRole("tab")[3]);
    expect(scrollTo).toHaveBeenCalledWith(expect.objectContaining({ behavior: "auto" }));
  });

  it("a tab on the phone's Tasks board still glides with neither", async () => {
    windowIs({ phone: true, systemReduces: false });
    const { user } = tasksOnAPhone();
    await waitFor(() => expect(screen.getByTestId("tasks-board")).toHaveAttribute("data-layout", "tabs"));
    const board = screen.getByTestId("tasks-board");
    const scrollTo = vi.fn();
    board.scrollTo = scrollTo as typeof board.scrollTo;
    await user.click(within(screen.getByRole("tablist", { name: "Columns" })).getAllByRole("tab")[3]);
    expect(scrollTo).toHaveBeenCalledWith(expect.objectContaining({ behavior: "smooth" }));
  });

  it("a section picked in Settings' index jumps there when the system asks for less motion", async () => {
    windowIs({ phone: false, systemReduces: true });
    const scrollIntoView = vi.spyOn(Element.prototype, "scrollIntoView").mockImplementation(() => {});
    const { user } = renderApp(<LockScreenProvider><UpdateProvider><Settings /></UpdateProvider></LockScreenProvider>, { route: "/settings" });
    scrollIntoView.mockClear();
    await user.click(screen.getByTestId("settings-index-privacy"));
    expect(scrollIntoView).toHaveBeenCalledWith({ block: "start", behavior: "auto" });
  });
});
