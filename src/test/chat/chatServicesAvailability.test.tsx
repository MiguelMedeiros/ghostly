import { act, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { LinkView } from "@ghostly/browser/shared/types";
import { ChatServicesDialog } from "../../components/ChatServicesDialog";
import { servicesUnavailable } from "../../lib/servicesAvailability";
import type { PeerLinkState } from "../../lib/platform";
import { linkView } from "../fakeEngine";
import { renderApp } from "../render";

// covers: services.paired.negotiate, services.share

type Pairing = NonNullable<LinkView["pairing"]>;
const ready = { status: "ready", transport: "iroh/1" } as Pairing;
const both = { mine: ["calls/1", "services/1"], peer: ["calls/1", "services/1"] };

/** A paired chat's apps travel over its live session once both apps offer `services/1`; the dialog says why they cannot. */
describe("shared apps in a paired chat: why they cannot travel", () => {
  const peer = (patch: Partial<PeerLinkState>): PeerLinkState => ({ dataLink: "open", online: true, services: null, pairing: ready, sessionOffers: both, capabilities: { files: true, payments: false, services: true }, ...patch });

  it.each<[string, Partial<PeerLinkState>, string | null]>([
    ["both offer it, live", {}, null],
    ["an older chat (no paired session)", { sessionOffers: undefined, capabilities: { files: true, payments: false } }, null],
    ["this app offers nothing (the web app)", { sessionOffers: { mine: ["calls/1"], peer: both.peer }, capabilities: { files: true, payments: false, services: false } }, null],
    ["on the DHT", { dataLink: "idle", pairing: { status: "connecting" } as Pairing, sessionOffers: { mine: both.mine, peer: null }, capabilities: { files: false, payments: false, services: false } }, "Shared apps open while you are connected live."],
    ["live, the contact has not said (older app)", { sessionOffers: { mine: both.mine, peer: null }, capabilities: { files: true, payments: false, services: false } }, "Ana needs an updated Ghostly to open shared apps."],
    ["live, the contact does not offer it", { sessionOffers: { mine: both.mine, peer: ["calls/1"] }, capabilities: { files: true, payments: false, services: false } }, "Ana's app cannot open or share apps (the web app cannot reach local apps)."],
  ])("%s", (_, patch, want) => {
    expect(servicesUnavailable(peer(patch), "Ana")).toBe(want);
  });

  it("the chat's Services… dialog shows it under the title, and nothing once apps can travel", () => {
    const view = renderApp(<ChatServicesDialog peerPubKey="peer" name="Ana" onClose={() => {}} />);
    act(() => view.engine.update({ links: [linkView({ profile: "paired-chat/1", dataLink: "idle", pairing: { status: "connecting" } as Pairing,
      sessionOffers: { mine: both.mine, peer: null }, capabilities: { files: false, payments: false, services: false } })] }));
    expect(screen.getByTestId("chat-services-unavailable")).toHaveTextContent("Shared apps open while you are connected live.");

    act(() => view.engine.update({ links: [linkView({ profile: "paired-chat/1", pairing: ready, sessionOffers: both,
      capabilities: { files: true, payments: false, services: true } })] }));
    expect(screen.queryByTestId("chat-services-unavailable")).not.toBeInTheDocument();
  });
});
