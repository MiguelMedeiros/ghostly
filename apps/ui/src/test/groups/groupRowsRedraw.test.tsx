import { act, screen, within } from "@testing-library/react";
import { Route, Routes } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { MESSAGE_CHANGES_TICK_MS } from "@ghostly/browser/platform/engine";
import type { GroupMemberView, PinView, StoredMessage } from "@ghostly/browser/shared/types";
import { GroupChat } from "../../pages/GroupChat";
import { fakeEngine, groupView, linkView } from "../fakeEngine";
import { renderApp } from "../render";

// covers: groups.typing, groups.reactions, groups.pins, groups.replies

/*
 * An open group's state changes all the time in ways its message rows show nothing of: a member starting or stopping
 * typing (the header's line), a member coming online or going away (the header's count). Neither draws the 100 rows
 * on screen again, as in a 1:1 chat (chatLinkRedraw.test.tsx). A row is drawn again only when what it shows changes:
 * a message arriving draws its own row, a pin, a reaction or a choice in Select the row it is about.
 */

const counts = vi.hoisted(() => ({ page: 0, rows: new Map<string, number>() }));

// One per drawing of the group page: it asks for its search once per draw.
vi.mock("../../hooks/useChatSearch", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../hooks/useChatSearch")>();
  return { ...actual, useChatSearch: (...args: Parameters<typeof actual.useChatSearch>) => { counts.page++; return actual.useChatSearch(...args); } };
});

// One per drawing of a message row, by its message.
vi.mock("../../components/MessageBubble", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../components/MessageBubble")>();
  return { ...actual, MessageBubble: (props: Parameters<typeof actual.MessageBubble>[0]) => {
    counts.rows.set(props.message.id, (counts.rows.get(props.message.id) ?? 0) + 1);
    return actual.MessageBubble(props);
  } };
});

const ME = "me".padEnd(52, "y"), ANA = "ana".padEnd(52, "y"), BO = "bo".padEnd(52, "y");
const T0 = 1_700_000_000_000;
const N = 150;
const member = (patch: Partial<GroupMemberView>): GroupMemberView => ({ key: ME, role: "member", me: false, online: true, missing: 0, ...patch });
const id = (i: number) => `${i % 2 ? ANA : BO}:1:${i}`;
const stored = (i: number, patch: Partial<StoredMessage> = {}): StoredMessage =>
  ({ linkId: "group:group-1", id: id(i), text: `Message ${i}`, sender: "peer", member: i % 2 ? ANA : BO, timestamp: T0 + i * 60_000, via: "datalink", ...patch });
/** The group as the engine's state brings it: a new object every time. */
const state = (patch: { typing?: boolean; boOnline?: boolean; pin?: PinView } = {}) => ({
  groups: [groupView({ status: "active", epoch: 1, myKey: ME, memberLinks: { "link-ana": ANA }, ...(patch.typing && { typing: [{ key: ANA }] }), ...(patch.pin && { pin: patch.pin }),
    members: [member({ key: ME, me: true }), member({ key: ANA, nick: "Ana" }), member({ key: BO, nick: "Bo", online: patch.boOnline ?? true })] })],
  links: [linkView({ id: "link-ana", peerPubKeyZ32: ANA, profile: "paired-chat/1" } as never)],
});
const tick = () => act(() => new Promise<void>((done) => setTimeout(done, MESSAGE_CHANGES_TICK_MS * 2)));
const reset = () => { counts.page = 0; counts.rows.clear(); };
const drawn = () => [...counts.rows.values()].reduce((a, b) => a + b, 0);
const row = (i: number) => document.querySelector<HTMLElement>(`[data-message-id="${id(i)}"]`)!;

async function openGroup() {
  const history = Array.from({ length: N }, (_, i) => stored(i));
  fakeEngine.on("groupMessages", () => history).on("updateSettings", () => undefined).on("setGroupTyping", () => undefined)
    .on("pinMessage", () => ({ error: null })).on("sendGroupMessage", () => ({ error: null })).update(state() as never);
  const app = renderApp(<Routes><Route path="/group/:groupId" element={<GroupChat />} /></Routes>, { route: "/group/group-1" });
  await screen.findByText(`Message ${N - 1}`);
  await tick();
  return app;
}

describe("an open group on a change its message rows do not show", () => {
  it("shows a member typing in the header without drawing the page or its rows", async () => {
    await openGroup();
    expect(drawn()).toBeGreaterThanOrEqual(100);

    reset();
    for (let i = 0; i < 25; i++) {
      act(() => fakeEngine.update(state({ typing: true }) as never));
      expect(screen.getByTestId("group-typing")).toHaveTextContent("Ana is typing");
      act(() => fakeEngine.update(state({ typing: false }) as never));
      expect(screen.queryByTestId("group-typing")).toBeNull();
    }
    await tick();
    expect(drawn()).toBe(0);
    expect(counts.page).toBe(0);
  });

  it("counts the members reachable in the header without drawing its rows", async () => {
    await openGroup();

    reset();
    for (let i = 0; i < 20; i++) {
      act(() => fakeEngine.update(state({ boOnline: false }) as never));
      expect(screen.getByTestId("group-members")).toHaveTextContent("1 of 2 reachable");
      act(() => fakeEngine.update(state({ boOnline: true }) as never));
      expect(screen.getByTestId("group-members")).toHaveTextContent("2 of 2 reachable");
    }
    await tick();
    expect(counts.page).toBeGreaterThan(0);
    expect(drawn()).toBe(0);
  });

  it("draws a message arriving as its own row only, none of the rows already there", async () => {
    await openGroup();

    reset();
    act(() => fakeEngine.emit({ kind: "message-changes", linkId: "group:group-1", messages: [stored(N)], deleted: [] }));
    await tick();
    await screen.findByText(`Message ${N}`);
    expect([...counts.rows.keys()]).toEqual([id(N)]);
  });
});

describe("an open group on a change one of its rows shows", () => {
  it("draws the row a pin or a reaction is about, and only it", async () => {
    const { user } = await openGroup();

    reset();
    act(() => fakeEngine.update(state({ pin: { id: id(145), by: ANA, at: T0 } }) as never));
    await tick();
    expect([...counts.rows.keys()]).toEqual([id(145)]);
    await user.click(within(row(145)).getByTestId("message-options"));
    expect(screen.getByTestId("message-pin")).toHaveTextContent("Unpin");
    await user.keyboard("{Escape}");

    reset();
    act(() => fakeEngine.emit({ kind: "message-changes", linkId: "group:group-1", messages: [stored(147, { reactions: { [ANA]: { e: "👍", n: 1, at: T0 } } })], deleted: [] }));
    await tick();
    expect([...counts.rows.keys()]).toEqual([id(147)]);
    expect(within(row(147)).getByText("👍")).toBeInTheDocument();
  });

  it("draws the row chosen in Select, and only it", async () => {
    const { user } = await openGroup();
    await user.click(within(row(148)).getByTestId("message-options"));
    await user.click(screen.getByTestId("message-select-start"));
    expect(screen.getByTestId("select-count")).toHaveTextContent("1 selected");

    reset();
    await user.click(within(row(146)).getByTestId("message-select"));
    expect(screen.getByTestId("select-count")).toHaveTextContent("2 selected");
    expect(within(row(146)).getByTestId("message-select")).toHaveAttribute("aria-checked", "true");
    expect([...counts.rows.keys()]).toEqual([id(146)]);
  });

  it("a row's actions do what the group says now, though the row was not drawn again", async () => {
    const { user, engine } = await openGroup();
    for (let i = 0; i < 5; i++) {
      act(() => fakeEngine.update(state({ typing: true }) as never));
      act(() => fakeEngine.update(state({ typing: false }) as never));
    }
    act(() => fakeEngine.update(state({ pin: { id: id(145), by: ANA, at: T0 } }) as never));
    await tick();

    // Pin on the pinned row takes it off; on another row, pins that one.
    await user.click(within(row(145)).getByTestId("message-options"));
    await user.click(screen.getByTestId("message-pin"));
    await user.click(within(row(141)).getByTestId("message-options"));
    await user.click(screen.getByTestId("message-pin"));
    expect(engine.callsTo("pinMessage")).toEqual([
      { linkId: "group:group-1", messageId: id(145), remove: true },
      { linkId: "group:group-1", messageId: id(141), remove: false },
    ]);

    // Reply answers the message as the group has it now.
    act(() => fakeEngine.emit({ kind: "message-changes", linkId: "group:group-1", messages: [stored(143, { text: "Message 143, edited" })], deleted: [] }));
    await tick();
    await user.click(within(row(143)).getByTestId("message-options"));
    await user.click(screen.getByTestId("message-reply"));
    expect(within(screen.getByTestId("composer-reply")).getByTestId("reply-quote-snippet")).toHaveTextContent("Message 143, edited");
    await user.type(screen.getByRole("textbox"), "yes{Enter}");
    expect(engine.callsTo("sendGroupMessage")).toEqual([{ groupId: "group-1", text: "yes", replyTo: id(143) }]);
  });
});
