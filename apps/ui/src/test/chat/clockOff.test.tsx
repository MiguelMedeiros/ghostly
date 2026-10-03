import { act, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { LinkView } from "@ghostly/browser/shared/types";
import { ChatConnection } from "../../components/ChatConnection";
import { clockOffAmount } from "../../lib/clockOff";
import { NetworkSettings } from "../../components/NetworkSettings";
import { locales } from "../../locales";
import { linkView } from "../fakeEngine";
import { renderApp } from "../render";

// covers: app.clock-off

type Pairing = NonNullable<LinkView["pairing"]>;
const RELAYS = ["https://pkarr.pubky.org"];
const web = { protocol: "Pkarr relays (HTTP) → Mainline DHT (BEP44)", relays: RELAYS };
const live = linkView({ availableTransports: ["webrtc/1"], peerTransports: ["webrtc/1"], transportAutomatic: true, pairing: { status: "ready", transport: "webrtc/1" } as Pairing, dataLink: "open" });
const waiting = linkView({ availableTransports: ["webrtc/1"], peerTransports: [], transportAutomatic: true });
const HINT = "This device's clock seems to be off by about 2 minutes. Chats may be slow to connect.";

describe("the note that this device's clock seems to be off", () => {
  it("is in the chat's connection panel while the engine says so, one short line with the story behind its ⓘ", async () => {
    const view = renderApp(<ChatConnection peerKey="peer" />);
    act(() => view.engine.update({ transport: { ...web, clockOffMs: 2 * 60_000 + 3_000 }, links: [live] }));
    await view.user.click(screen.getByTestId("connection-options"));
    const panel = screen.getByRole("dialog", { name: "Connection options" });
    const note = within(panel).getByTestId("connection-clock-off");
    expect(note).toHaveTextContent(HINT);
    // No alarm: a line among the others, and its story only when asked for.
    expect(within(panel).queryByRole("alert")).toBeNull();
    expect(within(note).queryByTestId("connection-clock-off-text")).toBeNull();
    const more = within(note).getByRole("button", { name: "More info" });
    expect(more).toHaveAttribute("aria-expanded", "false");
    await view.user.click(more);
    expect(more).toHaveAttribute("aria-expanded", "true");
    const story = within(note).getByTestId("connection-clock-off-text");
    expect(story).toHaveTextContent("about 2 minutes ahead of what the relays and your contacts' devices say");
    expect(story).toHaveTextContent("Set the date and time to automatic");
    expect(story).toHaveTextContent("never one contact alone");

    // Behind says so, and an hour reads as an hour.
    act(() => view.engine.update({ transport: { ...web, clockOffMs: -3 * 60 * 60_000 }, links: [live] }));
    expect(within(panel).getByTestId("connection-clock-off")).toHaveTextContent("off by about 3 hours");
    expect(within(panel).getByTestId("connection-clock-off-text")).toHaveTextContent("about 3 hours behind what the relays");

    // The clock agrees again: the note goes by itself.
    act(() => view.engine.update({ transport: web, links: [live] }));
    expect(screen.queryByTestId("connection-clock-off")).toBeNull();
  });

  it("is there for a chat that is not connected yet too: that is when it matters", async () => {
    const view = renderApp(<ChatConnection peerKey="peer" />);
    act(() => view.engine.update({ transport: { ...web, clockOffMs: -2 * 60_000 }, links: [waiting] }));
    await view.user.click(screen.getByTestId("connection-options"));
    expect(screen.getByTestId("connection-clock-off")).toHaveTextContent(HINT);
  });

  it("is in Settings, Network too, with the same words", async () => {
    const view = renderApp(<NetworkSettings />);
    act(() => view.engine.update({ transport: web, settings: { relays: RELAYS } }));
    expect(screen.queryByTestId("network-clock-off")).toBeNull();
    act(() => view.engine.update({ transport: { ...web, clockOffMs: 2 * 60_000 }, settings: { relays: RELAYS } }));
    const row = screen.getByTestId("network-clock-off");
    expect(row).toHaveTextContent("Device clock");
    expect(row).toHaveTextContent(HINT);
    await view.user.click(within(row).getByTestId("row-info"));
    expect(within(row).getByTestId("row-info-text")).toHaveTextContent("about 2 minutes ahead");
    act(() => view.engine.update({ transport: web, settings: { relays: RELAYS } }));
    expect(screen.queryByTestId("network-clock-off")).toBeNull();
  });

  it("says the amount to the minute, never less than one, in hours past ninety minutes, in the app's language", () => {
    expect(clockOffAmount(61_000, "en")).toBe("1 minute");
    expect(clockOffAmount(-89 * 60_000, "en")).toBe("89 minutes");
    expect(clockOffAmount(90 * 60_000, "en")).toBe("2 hours");
    expect(clockOffAmount(2 * 60_000, "pt")).toBe("2 minutos");
    expect(clockOffAmount(2 * 60_000, "not a language")).toBe("2 minutes");
  });

  it("has its words in every language, each with the amount, and no em dash", () => {
    for (const [language, strings] of Object.entries(locales)) {
      const clock = (strings as { connection: { clockOff: Record<string, string> } }).connection.clockOff;
      expect(Object.keys(clock).sort(), language).toEqual(["hint", "infoAhead", "infoBehind", "title"]);
      for (const key of ["hint", "infoAhead", "infoBehind"]) {
        expect(clock[key], `${language} ${key}`).toContain("{{amount}}");
        expect(clock[key], `${language} ${key}`).not.toContain("—");
      }
      expect(clock.infoAhead, language).not.toBe(clock.infoBehind);
      expect(clock.hint.length, `${language}: one short line`).toBeLessThan(140);
    }
  });
});
