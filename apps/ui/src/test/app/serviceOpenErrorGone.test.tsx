import { act, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { LinkView } from "@ghostly/browser/shared/types";
import { PeerServices } from "../../components/PeerServices";
import { saveSession } from "../../lib/storage";
import type { ChatSession } from "../../lib/types";
import { Services } from "../../pages/Services";
import { fakeEngine, linkView } from "../fakeEngine";
import { renderApp } from "../render";

// covers: services.open

/**
 * A contact's app that failed to open, then left their list (they went offline) and came back as another app: the
 * notice about the first app goes with it, rather than standing under the other one or under no app at all.
 */
const ana: ChatSession = { id: "ana", profile: "paired-chat/1", mySeedB64: "seed-ana", peerPubKeyB64: "peer", encKeyB64: "enc", label: "Ana", messages: [], createdAt: 1 };
const ready = { status: "ready", transport: "iroh/1" } as NonNullable<LinkView["pairing"]>;
const mk = (peerServices: LinkView["peerServices"] | null) => [linkView({ profile: "paired-chat/1", pairing: ready, sessionOffers: { mine: ["services/1"], peer: ["services/1"] },
  capabilities: { files: true, payments: false, services: true }, ...(peerServices ? { peerServices } : {}) })];

const PLACES = [
  { name: "the chat's apps strip", ui: <PeerServices peerPubKey="peer" onManage={() => {}} />, open: "open-service" },
  { name: "Services, From your contacts", ui: <Services />, open: "contact-service-open" },
];

const openService = fakeEngine.openService;
beforeEach(() => {
  saveSession(ana);
  fakeEngine.features = { ...fakeEngine.features, shareLocalServices: true, openServices: true };
  fakeEngine.openService = async () => { throw new Error("A call is on screen: Demo does not open over it"); };
});
afterEach(() => {
  fakeEngine.openService = openService;
  fakeEngine.features = { ...fakeEngine.features, shareLocalServices: false, openServices: false };
});

describe.each(PLACES)("an open that failed, in $name", ({ ui, open }) => {
  it("goes once that app is no longer listed", async () => {
    const view = renderApp(ui);
    act(() => view.engine.update({ links: mk([{ id: "demo", type: "http", name: "Demo" }]) }));
    await view.user.click(await screen.findByTestId(open));
    expect(await screen.findByRole("alert")).toHaveTextContent(/Demo/);
    act(() => view.engine.update({ links: mk(null) }));
    act(() => view.engine.update({ links: mk([{ id: "other", type: "http", name: "Other" }]) }));
    expect(await screen.findByTestId(open)).toHaveTextContent("Other");
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("stays while that app is still listed", async () => {
    const view = renderApp(ui);
    act(() => view.engine.update({ links: mk([{ id: "demo", type: "http", name: "Demo" }]) }));
    await view.user.click(await screen.findByTestId(open));
    act(() => view.engine.update({ links: mk([{ id: "demo", type: "http", name: "Demo" }, { id: "other", type: "http", name: "Other" }]) }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/Demo/);
  });
});
