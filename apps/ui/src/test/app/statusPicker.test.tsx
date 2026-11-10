import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PersonStatus } from "@ghostly/core";
import type { Settings as EngineSettings } from "@ghostly/browser/shared/types";
import { AccountBar } from "../../components/AccountBar";
import { StatusPickerHost } from "../../components/StatusPicker";
import { LockScreenProvider } from "../../contexts/LockScreenContext";
import { UpdateProvider } from "../../contexts/UpdateContext";
import { PRESENCE_TELL_EVERY_MS, usePresence } from "../../hooks/useOwnStatus";
import { Settings } from "../../pages/Settings";
import { axeViolations } from "../axe";
import { fakeEngine } from "../fakeEngine";
import { renderApp } from "../render";
import { choose } from "../select";

// covers: chat.status.picker, settings.share-presence

const NOW = new Date(2026, 10, 9, 10, 0).getTime();

/** The engine as slice 3 has it: a status set or cleared is kept in its settings and said in its state. */
function answerStatus(initial?: PersonStatus) {
  if (initial) fakeEngine.update({ settings: { ...fakeEngine.state.settings, ownStatus: initial } });
  fakeEngine.on("getOwnStatus", () => {
    const { ownStatus, sharePresence } = fakeEngine.state.settings;
    return { ...(ownStatus ? { status: ownStatus } : {}), sharePresence: sharePresence !== false };
  });
  fakeEngine.on("setOwnStatus", ({ status }) => { act(() => fakeEngine.update({ settings: { ...fakeEngine.state.settings, ownStatus: status } })); });
  fakeEngine.on("clearOwnStatus", () => {
    const { ownStatus: _gone, ...settings } = fakeEngine.state.settings;
    act(() => fakeEngine.setState({ ...fakeEngine.state, settings }));
  });
}

function renderBar(language?: "ar") {
  return renderApp(<><AccountBar /><StatusPickerHost /></>, language ? { language } : {});
}

async function openPicker(user: ReturnType<typeof renderBar>["user"]) {
  await user.click(screen.getByTestId("account-profile"));
  await user.click(await screen.findByTestId("profile-switcher-status"));
  return screen.findByRole("dialog", { name: /^(Status|الحالة)$/ });
}

beforeEach(() => {
  fakeEngine.features = { ...fakeEngine.features, profiles: true };
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});
afterEach(() => {
  fakeEngine.features = { ...fakeEngine.features, profiles: false };
  vi.useRealTimers();
});

describe("the status picker in the account menu", () => {
  it("sets an availability, an emoji, a text and an end through the engine, and gives the focus back", async () => {
    answerStatus();
    const { user, engine } = renderBar();
    const dialog = await openPicker(user);
    await user.click(within(dialog).getByRole("radio", { name: "Busy" }));
    await user.click(within(dialog).getByRole("button", { name: "🍕" }));
    await user.type(within(dialog).getByRole("textbox", { name: "Status text" }), "At lunch");
    await choose(user, within(dialog).getByTestId("status-end"), "1h");
    await user.click(within(dialog).getByRole("button", { name: "Save" }));

    expect(engine.callsTo("setOwnStatus")).toEqual([{ status: { availability: "busy", emoji: "🍕", text: "At lunch", until: NOW + 3_600_000 } }]);
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(screen.getByTestId("account-profile")).toHaveFocus();

    await user.click(screen.getByTestId("account-profile"));
    const row = await screen.findByTestId("profile-switcher-status");
    await waitFor(() => expect(row).toHaveTextContent("🍕At lunch"));
    expect(row).toHaveAccessibleName(/^Your status: Busy, 🍕 ⁨At lunch⁩, until 11:00\sAM\. Change status$/);
  });

  it("clears the status, and Do not disturb says what it silences", async () => {
    answerStatus({ availability: "dnd", text: "Focus" });
    const { user, engine } = renderBar();
    const dialog = await openPicker(user);
    expect(within(dialog).getByRole("radio", { name: "Do not disturb" })).toBeChecked();
    expect(within(dialog).getByRole("textbox", { name: "Status text" })).toHaveValue("Focus");
    expect(dialog).toHaveTextContent("Calls still ring");
    await user.click(within(dialog).getByRole("button", { name: "Clear status" }));
    expect(engine.callsTo("clearOwnStatus")).toHaveLength(1);
    expect(engine.callsTo("setOwnStatus")).toHaveLength(0);
    await user.click(screen.getByTestId("account-profile"));
    await waitFor(() => expect(screen.getByTestId("profile-switcher-status")).toHaveTextContent("Set a status"));
  });

  it("keeps the text to 60 characters, counted as a person sees them", async () => {
    answerStatus();
    const { user, engine } = renderBar();
    const dialog = await openPicker(user);
    const field = within(dialog).getByRole("textbox", { name: "Status text" });
    fireEvent.change(field, { target: { value: `${"x".repeat(58)}😀😀😀😀` } });
    expect(field).toHaveValue(`${"x".repeat(58)}😀😀`);
    expect(within(dialog).getByTestId("status-count")).toHaveTextContent("60/60");
    await user.click(within(dialog).getByRole("button", { name: "Save" }));
    expect(engine.callsTo("setOwnStatus")[0]?.status.text).toBe(`${"x".repeat(58)}😀😀`);
  });

  it("sends a chosen time as until, and refuses one already past", async () => {
    answerStatus();
    const { user, engine } = renderBar();
    const dialog = await openPicker(user);
    await user.click(within(dialog).getByRole("radio", { name: "Away" }));
    await choose(user, within(dialog).getByTestId("status-end"), "custom");
    const when = within(dialog).getByLabelText("Clear at");
    fireEvent.change(when, { target: { value: "2026-11-09T09:30" } });
    await user.click(within(dialog).getByRole("button", { name: "Save" }));
    expect(within(dialog).getByRole("alert")).toHaveTextContent("Choose a time later than now.");
    expect(when).toHaveAttribute("aria-invalid", "true");
    expect(engine.callsTo("setOwnStatus")).toHaveLength(0);

    fireEvent.change(when, { target: { value: "2026-11-10T09:30" } });
    await user.click(within(dialog).getByRole("button", { name: "Save" }));
    expect(engine.callsTo("setOwnStatus")).toEqual([{ status: { availability: "away", until: new Date(2026, 10, 10, 9, 30).getTime() } }]);
  });

  it("ends Today at midnight, and Don't clear sends no end", async () => {
    answerStatus();
    const { user, engine } = renderBar();
    let dialog = await openPicker(user);
    await user.type(within(dialog).getByRole("textbox", { name: "Status text" }), "Out");
    await choose(user, within(dialog).getByTestId("status-end"), "today");
    await user.click(within(dialog).getByRole("button", { name: "Save" }));
    expect(engine.callsTo("setOwnStatus")[0]).toEqual({ status: { availability: "available", text: "Out", until: new Date(2026, 10, 10).getTime() } });

    dialog = await openPicker(user);
    await choose(user, within(dialog).getByTestId("status-end"), "never");
    await user.click(within(dialog).getByRole("button", { name: "Save" }));
    expect(engine.callsTo("setOwnStatus")[1]).toEqual({ status: { availability: "available", text: "Out" } });
  });

  it("in Arabic, keeps the person's text isolated in the menu row and in its name", async () => {
    answerStatus({ availability: "busy", emoji: "🍕", text: "At lunch" });
    const { user } = renderBar("ar");
    await user.click(screen.getByTestId("account-profile"));
    const row = await screen.findByTestId("profile-switcher-status");
    await waitFor(() => expect(row.querySelector("bdi")).toHaveTextContent("At lunch"));
    expect(row.querySelector("bdi")).toHaveAttribute("dir", "auto");
    expect(row.getAttribute("aria-label")).toContain("⁨At lunch⁩");
    await user.click(row);
    const dialog = await screen.findByRole("dialog", { name: "الحالة" });
    expect(within(dialog).getByRole("textbox")).toHaveAttribute("dir", "auto");
  });

  it("is clean for axe when open, and Escape closes it back to the account button", async () => {
    answerStatus({ availability: "away", emoji: "🌴", text: "On holiday", until: NOW + 86_400_000 });
    const { user } = renderBar();
    const dialog = await openPicker(user);
    expect(await axeViolations(dialog)).toEqual([]);
    expect(within(dialog).getByRole("radiogroup", { name: "Availability" })).toBeInTheDocument();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.getByTestId("account-profile")).toHaveFocus();
  });
});

describe("Settings: Share when I'm online", () => {
  it("is on by default, says what it shares, and writes sharePresence", async () => {
    const { user, engine } = renderApp(
      <LockScreenProvider><UpdateProvider><Routes><Route path="/settings" element={<Settings />} /></Routes></UpdateProvider></LockScreenProvider>,
      { route: "/settings" },
    );
    engine.on("updateSettings", ({ settings }) => { act(() => engine.update({ settings: { ...engine.state.settings, ...settings as Partial<EngineSettings> } })); });
    const toggle = screen.getByTestId("settings-share-presence");
    expect(toggle).toHaveAttribute("aria-checked", "true");
    expect(toggle).toHaveAccessibleName("Share when I'm online");
    expect(screen.getByTestId("settings-share-presence-row")).toHaveTextContent("Contacts see a dot while you use Ghostly. A status you set shows either way.");
    await user.click(toggle);
    expect(engine.callsTo("updateSettings")).toContainEqual({ settings: { sharePresence: false } });
    expect(await screen.findByTestId("settings-share-presence")).toHaveAttribute("aria-checked", "false");
    await user.click(screen.getByTestId("settings-share-presence"));
    expect(engine.callsTo("updateSettings")).toContainEqual({ settings: { sharePresence: true } });
  });
});

function Presence({ locked = false }: { locked?: boolean }) {
  usePresence(locked);
  return null;
}

describe("the page tells the engine the person is there", () => {
  /** What the page said, once its calls reached the engine (each waits for the connection first). */
  const said = async () => { await act(async () => {}); return fakeEngine.callsTo("setPresence").map((p) => p.presence); };
  let hidden = false;
  beforeEach(() => {
    hidden = false;
    vi.spyOn(document, "visibilityState", "get").mockImplementation(() => (hidden ? "hidden" : "visible"));
    fakeEngine.on("setPresence", () => {});
  });
  afterEach(() => { vi.restoreAllMocks(); });

  it("active as it opens and on input (once in a while), idle when the page is hidden, active again when back", async () => {
    renderApp(<Presence />);
    expect(await said()).toEqual(["active"]);
    fireEvent.keyDown(document.body, { key: "a" });
    fireEvent.pointerDown(document.body);
    expect(await said(), "input right after is not said again").toEqual(["active"]);
    vi.setSystemTime(NOW + PRESENCE_TELL_EVERY_MS);
    fireEvent.pointerDown(document.body);
    expect(await said()).toEqual(["active", "active"]);

    hidden = true;
    fireEvent(document, new Event("visibilitychange"));
    expect(await said()).toEqual(["active", "active", "idle"]);
    hidden = false;
    fireEvent(document, new Event("visibilitychange"));
    expect(await said()).toEqual(["active", "active", "idle", "active"]);
  });

  it("idle while the lock screen is up: typing a password is not using the app", async () => {
    const { rerender } = renderApp(<Presence />);
    rerender(<Presence locked />);
    expect(await said()).toEqual(["active", "idle"]);
    vi.setSystemTime(NOW + PRESENCE_TELL_EVERY_MS);
    fireEvent.keyDown(document.body, { key: "a" });
    expect(await said()).toEqual(["active", "idle"]);
    rerender(<Presence />);
    expect(await said()).toEqual(["active", "idle", "active"]);
  });
});
