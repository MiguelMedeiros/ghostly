import "fake-indexeddb/auto";
import { screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Chat } from "../../pages/Chat";
import { BlockedContacts } from "../../components/settings/BlockedContacts";
import { saveSession } from "../../lib/storage";
import { linkView } from "../fakeEngine";
import { renderApp } from "../render";

// covers: chat.paired.block

vi.mock("../../lib/sounds", () => ({ playSound: vi.fn(() => () => {}), startRinging: vi.fn(() => () => {}), installAudioGestures: () => () => {}, warmSound: () => {} }));

const BOB = "b".repeat(52);
/** The Block question, named for the contact (its name isolated with FSI/PDI). Another dialog of the chat may be open. */
const asked = () => screen.queryByRole("dialog", { name: /^Block .*Bob.*\?$/ });

async function openMenu(blocked = false) {
  saveSession({ id: "chat-1", profile: "paired-chat/1", mySeedB64: "c2VlZA", peerPubKeyB64: BOB, encKeyB64: "a2V5", participationSeedB64: "cGFydA", messages: [], createdAt: Date.now(), label: "Bob" });
  const utils = renderApp(<Chat sessionId="chat-1" visible onCallChange={() => {}} callLayer={null} />);
  utils.engine.on("ensureLink", () => ({ linkId: "link-1" })).on("setActiveLink", () => undefined).on("setContactBlocked", () => undefined);
  utils.engine.update({ links: [linkView({ id: "link-1", peerPubKeyZ32: BOB, label: "Bob", ...(blocked && { blocked: true as const }) })] });
  await utils.user.click(screen.getByTestId("chat-options"));
  return { ...utils, menu: within(await screen.findByTestId("chat-options-menu")) };
}

afterEach(() => { vi.restoreAllMocks(); localStorage.clear(); });

describe("⋮ → Block contact", () => {
  it("asks first, then blocks the contact by its key; Cancel blocks nothing", async () => {
    const { user, menu, engine } = await openMenu();
    await user.click(menu.getByTestId("chat-block"));
    expect(asked()).toHaveAccessibleDescription(/can no longer call you or send you anything/);
    let dialog = within(asked()!);
    await user.click(dialog.getByRole("button", { name: "Cancel" }));
    expect(asked()).toBeNull();
    expect(engine.callsTo("setContactBlocked")).toEqual([]);

    await user.click(screen.getByTestId("chat-options"));
    await user.click(within(await screen.findByTestId("chat-options-menu")).getByTestId("chat-block"));
    dialog = within(asked()!);
    await user.click(dialog.getByRole("button", { name: "Block" }));
    expect(engine.callsTo("setContactBlocked")).toEqual([{ peerPubKeyZ32: BOB, blocked: true }]);
    expect(asked()).toBeNull();
  });

  it("a blocked contact's chat offers Unblock contact instead, which asks nothing", async () => {
    const { user, menu, engine } = await openMenu(true);
    expect(menu.queryByTestId("chat-block")).toBeNull();
    await user.click(menu.getByTestId("chat-unblock"));
    expect(screen.queryByRole("dialog", { name: /^Unblock/ })).toBeNull();
    expect(asked()).toBeNull();
    expect(engine.callsTo("setContactBlocked")).toEqual([{ peerPubKeyZ32: BOB, blocked: false }]);
  });
});

describe("Settings → Blocked contacts", () => {
  it("lists each blocked contact by its chat's name (its key once no chat is left), and unblocks it", async () => {
    const utils = renderApp(<BlockedContacts />);
    expect(screen.getByTestId("settings-blocked-none")).toHaveTextContent("No blocked contacts");
    const gone = "g".repeat(52);
    utils.engine.on("setContactBlocked", () => undefined);
    utils.engine.update({ links: [linkView({ id: "link-1", peerPubKeyZ32: BOB, label: "Bob" })], settings: { blockedContacts: [BOB, gone] } as never });
    const rows = await screen.findAllByTestId("settings-blocked-contact");
    expect(rows[0]).toHaveTextContent("Bob");
    expect(rows[1]).toHaveTextContent(/^Contact · /);
    await utils.user.click(screen.getByRole("button", { name: /^Unblock .*Bob/ }));
    expect(utils.engine.callsTo("setContactBlocked")).toEqual([{ peerPubKeyZ32: BOB, blocked: false }]);
  });

  it("Unblock hands the focus to the next row's Unblock once its own row is gone, not to the page", async () => {
    const utils = renderApp(<BlockedContacts />);
    const keys = ["a", "c", "d"].map((k) => k.repeat(52));
    const names = ["Ana", "Carl", "Dina"];
    utils.engine.update({ links: keys.map((key, i) => linkView({ id: `link-${i}`, peerPubKeyZ32: key, label: names[i] })), settings: { blockedContacts: keys } as never });
    // The engine's state drops the key before its answer comes, as the real one does.
    utils.engine.on("setContactBlocked", ({ peerPubKeyZ32 }) => {
      utils.engine.update({ settings: { blockedContacts: (utils.engine.state.settings.blockedContacts ?? []).filter((k) => k !== peerPubKeyZ32) } as never });
      return undefined;
    });
    await utils.user.click(await screen.findByRole("button", { name: /^Unblock .*Ana/ }));
    await vi.waitFor(() => expect(screen.getAllByTestId("settings-blocked-contact")).toHaveLength(2));
    await vi.waitFor(() => expect(screen.getByRole("button", { name: /^Unblock .*Carl/ })).toHaveFocus());
  });
});
