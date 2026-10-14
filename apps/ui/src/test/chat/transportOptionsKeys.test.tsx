import { act, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { LinkView } from "@ghostly/browser/shared/types";
import { ChatConnection } from "../../components/ChatConnection";
import { linkView } from "../fakeEngine";
import { renderApp } from "../render";

// covers: transport.chat-switch

type Pairing = NonNullable<LinkView["pairing"]>;
const all = ["webrtc/1", "iroh/1", "hyperdht/1"] as LinkView["availableTransports"];

async function open(link: Partial<LinkView>, language?: "ar") {
  const view = renderApp(<ChatConnection peerKey="peer" />, language ? { language } : undefined);
  act(() => view.engine.update({ links: [linkView({ pairing: { status: "ready", transport: "webrtc/1" } as Pairing, dataLink: "open", ...link })] }));
  view.engine.on("setChatTransport", () => undefined);
  await view.user.click(screen.getByTestId("connection-options"));
  const group = screen.getByTestId("transport-options");
  const radio = (id: string) => within(group).getByTestId(`connection-option-${id}`);
  const focused = () => document.activeElement?.getAttribute("data-testid")?.replace("connection-option-", "");
  return { ...view, group, radio, focused };
}

/**
 * The connection choices were a radiogroup that arrow keys did not move in, each radio its own Tab stop. Now they are
 * one Tab stop (the checked choice), and the arrows move between the choices that can be made.
 */
describe("the connection choices, by keyboard", () => {
  it("are one Tab stop, the checked choice, and the arrows move past what is off, around the ends", async () => {
    // Iroh chosen; HyperDHT off (the contact's app lacks it).
    const { user, radio, focused, engine } = await open({ availableTransports: all, peerTransports: ["webrtc/1", "iroh/1"], preferredTransport: "iroh/1", transportAutomatic: false });
    expect(["auto", "webrtc", "iroh", "hyperdht", "dht"].map(id => radio(id).tabIndex)).toEqual([-1, -1, 0, -1, -1]);

    radio("iroh").focus();
    await user.keyboard("{ArrowDown}");
    expect(focused()).toBe("dht"); // HyperDHT is off: skipped
    await user.keyboard("{ArrowDown}");
    expect(focused()).toBe("auto"); // around the end
    await user.keyboard("{ArrowUp}");
    expect(focused()).toBe("dht");
    await user.keyboard("{ArrowRight}");
    expect(focused()).toBe("auto");
    await user.keyboard("{ArrowLeft}");
    expect(focused()).toBe("dht");
    await user.keyboard("{Home}");
    expect(focused()).toBe("auto");
    await user.keyboard("{End}");
    expect(focused()).toBe("dht");
    // Moving chooses nothing: the live session moves only when a choice is made.
    expect(engine.callsTo("setChatTransport")).toEqual([]);
    await user.keyboard("{ArrowUp}{ArrowUp}");
    expect(focused()).toBe("webrtc");
    await user.keyboard(" ");
    expect(engine.callsTo("setChatTransport")).toEqual([{ linkId: "link-1", transport: "webrtc/1" }]);
  });

  it("with nothing checked that can be chosen, the first choice that can is the Tab stop", async () => {
    // HyperDHT chosen, but off here: the first enabled choice takes the Tab stop.
    const { radio } = await open({ availableTransports: ["webrtc/1", "iroh/1"], preferredTransport: "hyperdht/1", transportAutomatic: false });
    expect(["auto", "webrtc", "iroh", "hyperdht", "dht"].map(id => radio(id).tabIndex)).toEqual([0, -1, -1, -1, -1]);
  });

  it("in Arabic, Left goes on and Right goes back, as the page reads", async () => {
    const { user, group, radio, focused } = await open({ availableTransports: all, transportAutomatic: true }, "ar");
    group.style.direction = "rtl";
    radio("auto").focus();
    await user.keyboard("{ArrowLeft}");
    expect(focused()).toBe("webrtc");
    await user.keyboard("{ArrowRight}");
    expect(focused()).toBe("auto");
  });

  it("show the keyboard focus with the accent ring, not only a background a shade off the dialog's", async () => {
    const { radio } = await open({ availableTransports: all, transportAutomatic: true });
    for (const id of ["auto", "webrtc", "iroh", "hyperdht", "dht"])
      expect(radio(id).className.split(/\s+/)).toEqual(expect.arrayContaining(["focus-visible:ring-2", "focus-visible:ring-accent"]));
  });
});
