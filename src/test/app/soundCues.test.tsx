import { act, screen, waitFor } from "@testing-library/react";
import { Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AttentionEvent } from "@ghostly/browser/shared/rpc";
import { AttentionFeedback } from "../../components/AttentionFeedback";
import { ConfirmRealMoney } from "../../components/ConfirmRealMoney";
import { RichText } from "../../components/rich/RichText";
import { useCardFlip } from "../../components/deck/useCardFlip";
import { Deck } from "../../components/deck/Deck";
import { useState } from "react";
import { LockScreenProvider } from "../../contexts/LockScreenContext";
import { UpdateProvider } from "../../contexts/UpdateContext";
import { groupChat, setChatMute } from "../../lib/chatMute";
import { CATEGORY_PREVIEW, CUES, CueChat, REPEAT_MS, cueOutcome, eventSound, playCue, resetCues, type CueName } from "../../lib/cues";
import { CUE_CATEGORIES, DEFAULT_CUES, loadSettings, saveSettings, type CueSwitches, type NotificationSettings } from "../../lib/settings";
import { SOUNDS } from "../../lib/sounds";
import { saveSession } from "../../lib/storage";
import type { ChatSession } from "../../lib/types";
import { Settings } from "../../pages/Settings";
import { fakeEngine, linkView } from "../fakeEngine";
import { renderApp } from "../render";

// covers: app.attention.cues

const sound = vi.hoisted(() => ({ playSound: vi.fn((_name: string) => () => {}) }));
vi.mock("../../lib/sounds", async (original) => ({ ...(await original<typeof import("../../lib/sounds")>()), playSound: sound.playSound, installAudioGestures: () => () => {} }));
vi.mock("../../lib/notifications", async (original) => ({ ...(await original<typeof import("../../lib/notifications")>()), showPrivateNotification: vi.fn(async () => {}) }));

const played = () => sound.playSound.mock.calls.map(([name]) => name);
const notifications = (cues: Partial<CueSwitches> = {}, soundEnabled = true): NotificationSettings => ({ soundEnabled, systemEnabled: false, cues: { ...DEFAULT_CUES, ...cues } });
const setCues = (cues: Partial<CueSwitches>, soundEnabled = true) => saveSettings({ ...loadSettings(), notifications: notifications(cues, soundEnabled) });
const ALL: CueName[] = Object.keys(CUES) as CueName[];
const key = (c: string) => c.repeat(52);
const chat = (id: string): ChatSession => ({ id, profile: "paired-chat/1", mySeedB64: `seed-${id}`, peerPubKeyB64: key(id), encKeyB64: "enc", messages: [], createdAt: Date.now() });
let focused = true;

beforeEach(() => {
  focused = true;
  vi.spyOn(document, "hasFocus").mockImplementation(() => focused);
});
afterEach(() => {
  vi.restoreAllMocks();
  sound.playSound.mockClear();
  resetCues();
});

describe("sound categories: what each switch lets play", () => {
  it("has Payments, Identities, Connection and Chat on, and Interface off, unless changed", () => {
    expect(loadSettings().notifications.cues).toEqual({ payments: true, identities: true, connection: true, chat: true, interface: false });
    // Settings saved before the categories: the same.
    localStorage.setItem("ghostly_app_settings", JSON.stringify({ notifications: { soundEnabled: true, systemEnabled: false } }));
    expect(loadSettings().notifications.cues).toEqual(DEFAULT_CUES);
    localStorage.setItem("ghostly_app_settings", JSON.stringify({ notifications: { soundEnabled: true, systemEnabled: false, cues: { chat: false } } }));
    expect(loadSettings().notifications.cues).toEqual({ ...DEFAULT_CUES, chat: false });
  });

  it("gates each cue by its own category, and all of them by the Sounds switch", () => {
    for (const cue of ALL) {
      const category = CUES[cue].category;
      expect(cueOutcome(cue, notifications({ [category]: true }), false, false)).toBe(true);
      expect(cueOutcome(cue, notifications({ [category]: false }), false, false)).toBe(false);
      expect(cueOutcome(cue, notifications({ [category]: true }, false), false, false)).toBe(false);
      // Another category's switch changes nothing for it.
      for (const other of CUE_CATEGORIES.filter(c => c !== category)) expect(cueOutcome(cue, notifications({ [category]: true, [other]: false }), false, false)).toBe(true);
    }
  });

  it("puts each cue in the category the settings name", () => {
    const byCategory = (category: string) => ALL.filter(c => CUES[c].category === category).sort();
    expect(byCategory("payments")).toEqual(["failed", "paid", "realmoney", "request", "testcoins"]);
    expect(byCategory("identities")).toEqual(["checked", "sealed", "shared"]);
    expect(byCategory("connection")).toEqual(["back", "knock", "switched"]);
    expect(byCategory("chat")).toEqual(["deleted", "downloaded", "mention", "spoiler"]);
    expect(byCategory("interface")).toEqual(["flip", "group", "slide", "wallet"]);
  });

  it("silences a muted chat's cues, as its messages, and nothing that belongs to no chat", () => {
    const chatScoped = ALL.filter(c => cueOutcome(c, notifications({ interface: true }), true, false) === false).sort();
    expect(chatScoped).toEqual(["checked", "deleted", "downloaded", "failed", "knock", "mention", "request", "shared", "spoiler"]);
  });

  it("plays nothing new in the background; a cue standing for a sound that already plays there keeps that sound's rules", () => {
    const inBackground = ALL.filter(c => cueOutcome(c, notifications({ interface: true }), false, true)).sort();
    expect(inBackground).toEqual(["group", "mention", "paid", "testcoins"]);
    for (const cue of inBackground) expect(CUES[cue]).toHaveProperty("replaces");
  });

  it("gives one of the first events its finer sound only while that category is on", () => {
    const on = notifications({ interface: true }), off = notifications({ payments: false, chat: false, interface: false });
    expect(eventSound({ type: "message", mention: true }, on)).toBe("mention");
    expect(eventSound({ type: "message", mention: true }, off)).toBe("message");
    expect(eventSound({ type: "message" }, on)).toBe("message");
    expect(eventSound({ type: "confirmed" }, on)).toBe("paid");
    expect(eventSound({ type: "confirmed" }, off)).toBe("confirmed");
    expect(eventSound({ type: "coin", cue: "testcoins" }, on)).toBe("testcoins");
    expect(eventSound({ type: "coin" }, on)).toBe("coin");
    expect(eventSound({ type: "coin", cue: "testcoins" }, off)).toBe("coin");
    expect(eventSound({ type: "message", cue: "group" }, on)).toBe("group");
    // Interface is off by default: a group made plays what it played before.
    expect(eventSound({ type: "message", cue: "group" }, notifications())).toBe("message");
    expect(eventSound({ type: "sent" }, on)).toBe("sent");
  });

  it("has a sound for every cue, each with notes no other sound plays (the e2e probe tells them apart by these)", () => {
    const players = new Map<number, Set<string>>();
    for (const [name, notes] of Object.entries(SOUNDS)) for (const { frequency } of notes) players.set(frequency, (players.get(frequency) ?? new Set()).add(name));
    for (const cue of ALL) {
      expect(SOUNDS[cue].length).toBeGreaterThan(0);
      for (const { frequency } of SOUNDS[cue]) expect([...players.get(frequency)!], `${cue} ${frequency}`).toEqual([cue]);
      // Its first note once: a probe counts the cue by it.
      expect(SOUNDS[cue].filter(n => n.frequency === SOUNDS[cue][0].frequency)).toHaveLength(1);
    }
    for (const category of CUE_CATEGORIES) expect(CUES[CATEGORY_PREVIEW[category]].category).toBe(category);
  });
});

describe("playCue: one sound per event", () => {
  it("plays an event's key once, and the same cue again within a moment once", () => {
    const now = 1_000_000;
    expect(playCue("knock", { key: "k1" }, now)).toBe(true);
    expect(playCue("knock", { key: "k1" }, now + 10 * REPEAT_MS)).toBe(false);
    expect(playCue("spoiler", {}, now)).toBe(true);
    expect(playCue("spoiler", {}, now + REPEAT_MS - 1)).toBe(false);
    expect(playCue("spoiler", {}, now + REPEAT_MS)).toBe(true);
    expect(played()).toEqual(["knock", "spoiler", "spoiler"]);
  });

  it("is silent for a muted chat, while its category is off, and in the background", () => {
    setChatMute("a", "forever");
    expect(playCue("spoiler", { chat: "a" })).toBe(false);
    expect(playCue("spoiler", { chat: "b" })).toBe(true);
    resetCues();
    setCues({ chat: false });
    expect(playCue("spoiler", { chat: "b" })).toBe(false);
    setCues({});
    focused = false;
    expect(playCue("spoiler", { chat: "b" })).toBe(false);
    expect(played()).toEqual(["spoiler"]);
  });
});

describe("AttentionFeedback plays the engine's cues", () => {
  let n = 0;
  const event = (patch: Partial<AttentionEvent>): AttentionEvent => ({ id: `cue-${++n}`, type: "cue", at: Date.now(), ...patch });
  function setup() {
    setCues({});
    saveSession(chat("a"));
    fakeEngine.update({ links: [linkView({ id: "link-a", peerPubKeyZ32: key("a") })] });
    renderApp(<AttentionFeedback />);
  }
  /** Sends `events`, then a coin that always plays, and gives what played before it. */
  async function send(...events: AttentionEvent[]) {
    const marker = event({ type: "coin" });
    act(() => { for (const e of [...events, marker]) fakeEngine.emit({ kind: "attention", event: e }); });
    await waitFor(() => expect(sound.playSound).toHaveBeenLastCalledWith("coin"));
    const heard = played().slice(0, -1);
    sound.playSound.mockClear();
    return heard;
  }

  it("plays a cue event once, even when it arrives twice", async () => {
    setup();
    const request = event({ cue: "request", linkId: "link-a" });
    expect(await send(request, request, event({ cue: "knock", linkId: "link-a" }))).toEqual(["request", "knock"]);
  });

  it("gives a mention and my settled payment their own sounds, and the first ones with those categories off", async () => {
    setup();
    expect(await send(event({ type: "message", mention: true, linkId: "group:g" }), event({ type: "confirmed" }))).toEqual(["mention", "paid"]);
    setCues({ chat: false, payments: false });
    expect(await send(event({ type: "message", mention: true, linkId: "group:g" }), event({ type: "confirmed" }))).toEqual(["message", "confirmed"]);
  });

  it("leaves a muted chat's cues out, and every new cue while the app is in the background", async () => {
    setup();
    setChatMute("a", "forever");
    setChatMute(groupChat("g"), "forever");
    expect(await send(event({ cue: "request", linkId: "link-a" }), event({ cue: "downloaded", linkId: "group:g" }), event({ cue: "switched", linkId: "link-a" }))).toEqual(["switched"]);
    focused = false;
    // In the background the new cues stay quiet; a mention in an unmuted group still plays, as its message did.
    expect(await send(event({ cue: "back" }), event({ cue: "request" }), event({ type: "message", mention: true, linkId: "group:h" }))).toEqual(["mention"]);
  });

  it("plays nothing of a category that is off", async () => {
    setup();
    setCues({ connection: false });
    expect(await send(event({ cue: "knock" }), event({ cue: "back" }), event({ cue: "sealed" }))).toEqual(["sealed"]);
  });
});

describe("cues the pages play", () => {
  it("a spoiler revealed pops, unless its chat is muted", async () => {
    setCues({});
    const { user } = renderApp(<CueChat.Provider value="a"><RichText text="||one||" /><RichText text="||two||" /></CueChat.Provider>);
    await user.click(screen.getAllByTestId("rich-spoiler")[0]);
    expect(played()).toEqual(["spoiler"]);
    setChatMute("a", "forever");
    resetCues();
    await user.click(screen.getAllByTestId("rich-spoiler")[1]);
    expect(screen.getAllByTestId("rich-spoiler")[1]).toHaveAttribute("data-shown");
    expect(played()).toEqual(["spoiler"]);
  });

  it("Send real money ticks as it is pressed, not Back", async () => {
    setCues({});
    const send = vi.fn(), back = vi.fn();
    const { user } = renderApp(<ConfirmRealMoney what="1,000 sats" onSend={send} onBack={back} />);
    await user.click(screen.getByTestId("review-confirm-back"));
    expect(played()).toEqual([]);
    await user.click(screen.getByTestId("review-confirm-send"));
    expect(played()).toEqual(["realmoney"]);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("a card turning over flips only with Interface sounds on", async () => {
    function Card() { const { side, turn, turnBack } = useCardFlip(); return <button type="button" onClick={side === "back" ? turnBack : turn}>{side}</button>; }
    const { user } = renderApp(<Card />);
    await user.click(screen.getByRole("button", { name: "cards" }));
    expect(played()).toEqual([]);
    setCues({ interface: true });
    await user.click(await screen.findByRole("button", { name: "back" }));
    expect(played()).toEqual(["flip"]);
  });
});

describe("the deck's slide", () => {
  function Cards() {
    const [selected, setSelected] = useState("a");
    return <>
      <button type="button" onClick={() => setSelected("c")}>From outside</button>
      <Deck cards={[{ id: "a" }, { id: "b" }, { id: "c" }]} selected={selected} onSelect={setSelected} kind="tabs" label="Cards" name="cue-deck"
        panel={{ id: "cue-panel", tabId: id => `cue-tab-${id}` }} testId={card => `cue-${card.id}`} face={card => <span data-deck="face">{card.id}</span>} mark={() => null} tone={() => ""} className="cue-deck" />
    </>;
  }

  it("plays as the person moves to another card (Interface on), not for a card chosen from outside", async () => {
    setCues({ interface: true });
    const { user } = renderApp(<><AttentionFeedback /><Cards /></>);
    await user.click(screen.getByTestId("cue-a"));
    await user.keyboard("{ArrowRight}");
    await waitFor(() => expect(played()).toEqual(["slide"]));
    await user.click(screen.getByRole("button", { name: "From outside" }));
    expect(screen.getByTestId("cue-c")).toHaveAttribute("aria-selected", "true");
    expect(played()).toEqual(["slide"]);
  });

  it("is silent while Interface sounds are off, as they are by default", async () => {
    const { user } = renderApp(<><AttentionFeedback /><Cards /></>);
    await user.click(screen.getByTestId("cue-a"));
    await user.keyboard("{ArrowRight}");
    expect(screen.getByTestId("cue-b")).toHaveAttribute("aria-selected", "true");
    expect(played()).toEqual([]);
  });
});

describe("Settings: one switch per category", () => {
  const renderSettings = () => renderApp(
    <LockScreenProvider><UpdateProvider><Routes><Route path="/settings" element={<Settings />} /></Routes></UpdateProvider></LockScreenProvider>,
    { route: "/settings" },
  );

  it("shows each category with a hint and a ▶, Interface off; a switch is kept, a ▶ plays that category's sound", async () => {
    const { user } = renderSettings();
    for (const category of CUE_CATEGORIES) {
      expect(screen.getByTestId(`settings-cues-${category}`)).toHaveAttribute("aria-checked", String(category !== "interface"));
      expect(screen.getByTestId(`settings-cues-${category}-preview`)).toBeEnabled();
    }
    expect(screen.getByTestId("settings-cues-chat-row")).toHaveTextContent("Mentions, spoilers, downloads, deletions");
    await user.click(screen.getByTestId("settings-cues-chat"));
    expect(screen.getByTestId("settings-cues-chat")).toHaveAttribute("aria-checked", "false");
    expect(loadSettings().notifications.cues).toMatchObject({ chat: false, payments: true, interface: false });
    await user.click(screen.getByTestId("settings-cues-interface"));
    expect(loadSettings().notifications.cues).toMatchObject({ chat: false, interface: true });
    await user.click(screen.getByTestId("settings-cues-payments-preview"));
    expect(played()).toEqual(["paid"]);
  });

  it("greys the categories out while Sounds is off", async () => {
    const { user } = renderSettings();
    await user.click(screen.getByTestId("settings-sounds"));
    for (const category of CUE_CATEGORIES) {
      expect(screen.getByTestId(`settings-cues-${category}`)).toBeDisabled();
      expect(screen.getByTestId(`settings-cues-${category}-preview`)).toBeDisabled();
    }
  });
});
