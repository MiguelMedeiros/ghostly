import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Route, Routes, useNavigate } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GroupMemberView, GroupView } from "@ghostly/browser/shared/types";
import { Root } from "../../Root";
import { GroupChat } from "../../pages/GroupChat";
import { saveSession } from "../../lib/storage";
import { fakeEngine, groupView } from "../fakeEngine";
import { renderApp } from "../render";

// covers: app.accessibility, app.mobile-layout

/*
 * On a touch screen the message field waits for a tap as a chat opens (the keyboard would come up). The row or New that
 * opened it goes with the chat list, which a phone keeps mounted but hidden: the focus fell to the page's body, and the
 * keys and a screen reader started again from its top. The chat's heading takes it, as a Settings section's title
 * does (layout/Page.tsx). With a mouse the message field takes it, as before.
 */

/** A phone (one screen at a time) with a touch screen only, or with a mouse too. */
function phone(touch: boolean) {
  const matchMedia = window.matchMedia.bind(window);
  vi.spyOn(window, "matchMedia").mockImplementation((query: string) => {
    const matches = query === "(max-width: 767px)" ? true : query === "(any-pointer: coarse)" ? touch : query === "(any-pointer: fine)" ? !touch : null;
    if (matches === null) return matchMedia(query);
    const still = () => {};
    return { matches, media: query, onchange: null, addEventListener: still, removeEventListener: still, addListener: still, removeListener: still, dispatchEvent: () => false } as MediaQueryList;
  });
}

/** Stylesheets are left out of these tests: the phone's hidden chat list is what this is about, so it hides here. */
let sheet: HTMLStyleElement;
beforeEach(() => {
  sheet = document.createElement("style");
  sheet.textContent = ".hidden { display: none; }";
  document.head.append(sheet);
});
afterEach(() => { sheet.remove(); vi.restoreAllMocks(); window.location.hash = ""; localStorage.clear(); });

const PEER = "p".repeat(43);
const save = () => saveSession({ id: "chat-1", profile: "paired-chat/1", mySeedB64: "c2VlZA", peerPubKeyB64: PEER, encKeyB64: "a2V5", label: "Ana", messages: [], createdAt: 1_700_000_000_000 });

/** The open chat's own heading (the hidden chat list has one of its own). */
const chatHeading = async () => (await screen.findByTestId("chat-name", undefined, { timeout: 5_000 })).closest("h1")!;
const field = () => screen.getByPlaceholderText<HTMLTextAreaElement>("Message…");

/** Every element `focus()` was called on, with its options. */
function focusCalls() {
  const calls: [Element, FocusOptions | undefined][] = [];
  const focus = HTMLElement.prototype.focus;
  vi.spyOn(HTMLElement.prototype, "focus").mockImplementation(function (this: HTMLElement, options?: FocusOptions) { calls.push([this, options]); focus.call(this, options); });
  return calls;
}

describe("a chat opened on a phone", () => {
  it("from its row, on a touch screen: the chat's heading has the focus, not the page, and the field waits for a tap", async () => {
    phone(true);
    save();
    const calls = focusCalls();
    const user = userEvent.setup();
    render(<Root />);
    const row = await screen.findByTestId("chat-row-open", undefined, { timeout: 5_000 });
    await user.click(row);
    const heading = await chatHeading();
    await waitFor(() => expect(heading).toHaveFocus());
    expect(heading).toHaveAttribute("tabindex", "-1");
    expect(heading).toHaveAccessibleName("Ana");
    expect(calls.find(([el]) => el === heading)?.[1]).toEqual({ preventScroll: true });
    expect(field()).not.toHaveFocus();
  }, 30_000);

  it("from New chat, on a touch screen: the new chat's heading has the focus", async () => {
    phone(true);
    const calls = focusCalls();
    const user = userEvent.setup();
    render(<Root />);
    await user.click(await screen.findByTestId("sidebar-new-chat", undefined, { timeout: 5_000 }));
    const heading = await chatHeading();
    await waitFor(() => expect(heading).toHaveFocus());
    expect(calls.find(([el]) => el === heading)?.[1]).toEqual({ preventScroll: true });
    expect(document.activeElement).not.toBe(document.body);
    expect(field()).not.toHaveFocus();
  }, 30_000);

  it("with a mouse too, the message field has the focus as before", async () => {
    phone(false);
    save();
    const user = userEvent.setup();
    render(<Root />);
    await user.click(await screen.findByTestId("chat-row-open", undefined, { timeout: 5_000 }));
    await chatHeading();
    await waitFor(() => expect(field()).toHaveFocus());
  }, 30_000);
});

const ME = "me".padEnd(52, "y"), ALICE = "alice".padEnd(52, "y");
const member = (patch: Partial<GroupMemberView>): GroupMemberView => ({ key: ME, role: "member", me: false, online: false, missing: 0, ...patch });
const active = (): GroupView => groupView({ status: "active", epoch: 1, members: [member({ key: ME, me: true, online: true }), member({ key: ALICE, nick: "Alice" })] });

/** The chat list's row for the group, hidden once the group opens, as on a phone; and the group. */
function openGroupFromList(group: GroupView | null) {
  fakeEngine.on("groupMessages", () => []).on("updateSettings", () => undefined);
  if (group) fakeEngine.update({ groups: [group] });
  const List = ({ shown }: { shown: boolean }) => {
    const navigate = useNavigate();
    return <div className={shown ? "" : "hidden"}><button type="button" data-testid="row" onClick={() => void navigate("/group/group-1")}>Friends</button></div>;
  };
  // Something else on screen beside the group (a voice message playing on, at the top).
  return renderApp(<Routes>
    <Route path="/" element={<List shown />} />
    <Route path="/group/:groupId" element={<><List shown={false} /><button type="button">elsewhere</button><GroupChat /></>} />
  </Routes>, { route: "/" });
}

describe("a group opened on a phone", () => {
  it.each([["a touch screen", true], ["a mouse too", false]] as const)("gives the focus to its heading on %s, else to the message field", async (_, touch) => {
    phone(touch);
    const calls = focusCalls();
    const { user } = openGroupFromList(active());
    await user.click(screen.getByTestId("row"));
    const heading = await screen.findByTestId("group-name");
    expect(heading.tagName).toBe("H1");
    if (touch) {
      await waitFor(() => expect(heading).toHaveFocus());
      expect(heading).toHaveAttribute("tabindex", "-1");
      expect(heading).toHaveAccessibleName("Friends");
      expect(calls.find(([el]) => el === heading)?.[1]).toEqual({ preventScroll: true });
      expect(screen.getByRole("textbox")).not.toHaveFocus();
    } else {
      await waitFor(() => expect(screen.getByRole("textbox")).toHaveFocus());
    }
  });

  it("leaves the focus where the person put it while the group was still on its way", async () => {
    phone(true);
    const { user } = openGroupFromList(null);
    await user.click(screen.getByTestId("row"));
    // The engine has no such group yet, and the person goes elsewhere on the screen meanwhile.
    expect(await screen.findByTestId("group-gone")).toBeInTheDocument();
    const elsewhere = screen.getByRole("button", { name: "elsewhere" });
    act(() => elsewhere.focus());
    act(() => fakeEngine.update({ groups: [active()] }));
    expect(await screen.findByTestId("group-name")).toBeInTheDocument();
    expect(elsewhere).toHaveFocus();
  });
});
