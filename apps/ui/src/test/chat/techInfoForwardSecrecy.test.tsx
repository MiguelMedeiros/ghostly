import "fake-indexeddb/auto";
import { screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { Chat } from "../../pages/Chat";
import { saveSession } from "../../lib/storage";
import { linkView } from "../fakeEngine";
import { renderApp } from "../render";

// covers: chat.ratchet.ui

vi.mock("../../lib/sounds", () => ({ playSound: vi.fn(() => () => {}), startRinging: vi.fn(() => () => {}), installAudioGestures: () => () => {} }));

const PEER = "peer".padEnd(52, "p");

/** A paired chat whose DHT floor says this of forward secrecy (WISP 4xx), its Tech Info open. */
async function techInfo(forwardSecrecy?: "on" | "starting" | "unsupported" | "stopped") {
  saveSession({ id: "chat-1", profile: "paired-chat/1", mySeedB64: "c2VlZA", peerPubKeyB64: PEER, encKeyB64: "a2V5", label: "Casper", messages: [], createdAt: 1_700_000_000_000 });
  const utils = renderApp(<Chat sessionId="chat-1" visible onCallChange={() => {}} callLayer={null} />);
  utils.engine.on("ensureLink", () => ({ linkId: "link-1" })).on("setActiveLink", () => undefined).on("sendMessage", () => ({ error: null }));
  utils.engine.update({ links: [linkView({ peerPubKeyZ32: PEER, profile: "paired-chat/1", pairing: { status: "ready" },
    dhtDelivery: { mode: "stream", authenticated: true, maxTextBytes: 256, ...(forwardSecrecy && { forwardSecrecy }) } } as never)] });
  await utils.user.click(await screen.findByTestId("chat-options"));
  await utils.user.click(screen.getByTestId("chat-tech-info"));
  return utils;
}

describe("a chat's Tech Info says whether forward secrecy is on", () => {
  it("On, with why behind ⓘ, and that a live connection has fresh keys anyway", async () => {
    const { user } = await techInfo("on");
    const row = screen.getByTestId("tech-forward-secrecy");
    expect(row).toHaveTextContent("Forward secrecy");
    expect(row).toHaveTextContent("On");
    expect(row).not.toHaveTextContent("stolen");
    await user.click(within(row).getByTestId("tech-forward-secrecy-info"));
    expect(row).toHaveTextContent("a key stolen later cannot open them");
    expect(row).toHaveTextContent("A live connection always uses fresh keys.");
  });

  for (const [state, why] of [["starting", "turns on once you have both written"], ["unsupported", "does not support it yet"], ["stopped", "no longer supports it"]] as const) {
    it(`Off while ${state}, and its ⓘ says why`, async () => {
      const { user } = await techInfo(state);
      const row = screen.getByTestId("tech-forward-secrecy");
      expect(row).toHaveAttribute("data-state", state);
      expect(row).toHaveTextContent("Off");
      await user.click(within(row).getByTestId("tech-forward-secrecy-info"));
      expect(row).toHaveTextContent(why);
    });
  }

  it("has no row where the engine says nothing of it (an app or chat without the ratchet)", async () => {
    await techInfo();
    expect(screen.getByRole("heading", { name: "Tech Info" })).toBeInTheDocument();
    expect(screen.queryByTestId("tech-forward-secrecy")).not.toBeInTheDocument();
  });
});

describe("a chat's Tech Info on a phone", () => {
  it("has its values that copy a thumb's height, at least 24 px", async () => {
    // The session id's row was 230 x 16 px on a phone on its side.
    await techInfo("on");
    // The session id and both keys (the connection panel's keys have the same title).
    const copies = screen.getAllByTitle("Click to copy");
    expect(copies.length).toBeGreaterThan(0);
    for (const copy of copies) expect(copy.className.split(/\s+/)).toContain("max-md:min-h-6");
  });
});
