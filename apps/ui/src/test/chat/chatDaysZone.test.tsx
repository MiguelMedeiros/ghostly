import { act, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Route, Routes } from "react-router-dom";
import type { GroupMemberView, StoredMessage } from "@ghostly/browser/shared/types";
import { Chat } from "../../pages/Chat";
import { GroupChat } from "../../pages/GroupChat";
import { forgetChatScroll } from "../../hooks/useChatScroll";
import { rowDays, rowDaysReader } from "../../lib/chatDays";
import { saveSession } from "../../lib/storage";
import type { ChatMessage } from "../../lib/types";
import { fakeEngine, groupView, linkView } from "../fakeEngine";
import { renderApp } from "../render";

// covers: chat.days

/**
 * A time zone change with a chat open (a trip: Chrome follows the device's zone live) keeps one date per day: the days
 * found in the old zone are found again in the new one, and Today with them, so today's messages stay under one Today.
 */

const zone = process.env.TZ;
const setZone = (tz: string) => { process.env.TZ = tz; };
/** Wednesday, November 25 2026 at `h`:00 UTC: the same day in São Paulo (UTC-3) and in Lisbon (UTC+0) from 03:00. */
const utc = (h: number) => Date.UTC(2026, 10, 25, h);

beforeEach(() => {
  setZone("America/Sao_Paulo");
  vi.useFakeTimers({ shouldAdvanceTime: true, now: utc(18) });
  forgetChatScroll();
});
afterEach(() => {
  vi.useRealTimers();
  if (zone === undefined) delete process.env.TZ;
  else process.env.TZ = zone;
});

it("the test's zone change moves local time at once", () => {
  expect(new Date(utc(18)).getHours()).toBe(15);
  setZone("Europe/Lisbon");
  expect(new Date(utc(18)).getHours()).toBe(18);
});

describe("the days of a chat's rows as its list changes", () => {
  type Row = { id: string; at: number };

  it("are found again in the new zone when the zone changed", () => {
    const read = rowDaysReader<Row>(row => row.at);
    const rows: Row[] = [{ id: "m1", at: utc(13) }, { id: "m2", at: utc(17) }];
    read(rows);
    setZone("Europe/Lisbon");
    const list = [...rows, { id: "m3", at: utc(18) }];
    expect(read(list)).toEqual(rowDays(list.map(row => row.at)));
    // The same list again, read in another zone: not the old zone's days.
    setZone("Asia/Tokyo");
    expect(read(list)).toEqual(rowDays(list.map(row => row.at)));
  });
});

describe("a 1:1 chat open while the zone changes", () => {
  const PEER = "peer".padEnd(52, "p");
  const message = (n: number, timestamp: number): ChatMessage => ({ id: `peer_m${n}`, ref: `m${n}`, sender: "peer", timestamp, text: `Message ${n}` });
  const labels = () => [...document.querySelectorAll<HTMLElement>("[data-message-list] section[data-day] [data-testid=chat-day]")].map(day => day.textContent);
  function open(messages: ChatMessage[]) {
    saveSession({ id: "chat-1", profile: "paired-chat/1", mySeedB64: "c2VlZA", peerPubKeyB64: PEER, encKeyB64: "a2V5", label: "Ana", messages, createdAt: utc(10) - 86_400_000 });
    const utils = renderApp(<Chat sessionId="chat-1" visible onCallChange={() => {}} callLayer={null} />);
    utils.engine.on("ensureLink", () => ({ linkId: "link-1" })).on("setActiveLink", () => undefined).on("sendMessage", () => ({ error: null }));
    utils.engine.update({ links: [linkView({ id: "link-1", peerPubKeyZ32: PEER, profile: "paired-chat/1", pairing: { status: "ready" } } as never)] });
    return utils;
  }

  it("keeps today's messages under one Today when a message comes in the new zone", async () => {
    const { user } = open([message(1, utc(13)), message(2, utc(17))]);
    await screen.findByText("Message 2");
    expect(labels()).toEqual(["Today"]);
    setZone("Europe/Lisbon");
    await user.click(await screen.findByPlaceholderText("Message…"));
    await user.keyboard("Message 3{Enter}");
    await screen.findByText("Message 3");
    expect(labels()).toEqual(["Today"]);
  });

  it("keeps them under Today when the page comes back in the new zone", async () => {
    open([message(1, utc(13)), message(2, utc(17))]);
    await screen.findByText("Message 2");
    setZone("Europe/Lisbon");
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"));
      window.dispatchEvent(new Event("focus"));
    });
    expect(labels()).toEqual(["Today"]);
  });
});

describe("a group open while the zone changes", () => {
  const ME = "me".padEnd(52, "y"), ALICE = "alice".padEnd(52, "y");
  const member = (patch: Partial<GroupMemberView>): GroupMemberView => ({ key: ME, role: "member", me: false, online: true, missing: 0, ...patch });
  const history: StoredMessage[] = [13, 17].map((h, i) => ({ linkId: "group:group-1", id: `g${i}`, text: `Message ${i}`, sender: "peer", member: ALICE, timestamp: utc(h), via: "datalink" }));

  it("keeps today's messages under Today when the page comes back in the new zone", async () => {
    fakeEngine.on("messagePage", () => ({ messages: history, more: false }))
      .on("groupMessages", () => history)
      .on("updateSettings", () => undefined)
      .update({ groups: [groupView({ status: "active", epoch: 1, members: [member({ key: ME, me: true }), member({ key: ALICE, nick: "Alice" })] })] });
    renderApp(<Routes><Route path="/group/:groupId" element={<GroupChat />} /></Routes>, { route: "/group/group-1" });
    await screen.findByText("Message 1");
    const labels = () => screen.getAllByTestId("chat-day").map(day => day.textContent);
    expect(labels()).toEqual(["Today"]);
    setZone("Europe/Lisbon");
    act(() => { window.dispatchEvent(new Event("focus")); });
    expect(labels()).toEqual(["Today"]);
  });
});
