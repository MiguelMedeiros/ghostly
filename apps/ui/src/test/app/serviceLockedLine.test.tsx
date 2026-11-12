import { act, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { LinkView } from "@ghostly/browser/shared/types";
import { ChatServicesDialog } from "../../components/ChatServicesDialog";
import { PeerServices } from "../../components/PeerServices";
import { SERVICE_LOCKED } from "../../lib/serviceWindows";
import { saveSession } from "../../lib/storage";
import type { ChatSession } from "../../lib/types";
import { Services } from "../../pages/Services";
import { fakeEngine, linkView } from "../fakeEngine";
import { renderApp } from "../render";

// covers: services.open

/**
 * A contact's app the profile's lock overtook while it opened on the web (apps/web/src/host.ts): the line under its
 * Open button says so in the app's language, and what to do, never the host's English.
 */
const ana: ChatSession = { id: "ana", profile: "paired-chat/1", mySeedB64: "seed-ana", peerPubKeyB64: "peer", encKeyB64: "enc", label: "Ana", messages: [], createdAt: 1 };
const ready = { status: "ready", transport: "iroh/1" } as NonNullable<LinkView["pairing"]>;
const links = [linkView({ profile: "paired-chat/1", pairing: ready, sessionOffers: { mine: ["services/1"], peer: ["services/1"] },
  capabilities: { files: true, payments: false, services: true }, peerServices: [{ id: "demo", type: "http", name: "Demo" }] })];

/** Each place a contact's app opens from, and its Open button. */
const PLACES = [
  { name: "the chat's apps strip", ui: <PeerServices peerPubKey="peer" onManage={() => {}} />, open: "open-service" },
  { name: "the chat's Services dialog", ui: <ChatServicesDialog peerPubKey="peer" name="Ana" onClose={() => {}} />, open: "chat-service-open" },
  { name: "Services, From your contacts", ui: <Services />, open: "contact-service-open" },
];

const openService = fakeEngine.openService;
beforeEach(() => {
  saveSession(ana);
  fakeEngine.features = { ...fakeEngine.features, shareLocalServices: true, openServices: true };
  fakeEngine.openService = async () => { throw new Error(SERVICE_LOCKED); };
});
afterEach(() => {
  fakeEngine.openService = openService;
  fakeEngine.features = { ...fakeEngine.features, shareLocalServices: false, openServices: false };
});

describe.each(PLACES)("an open the lock overtook, in $name", ({ ui, open }) => {
  it("says the profile locked and to open it again", async () => {
    const view = renderApp(ui);
    act(() => view.engine.update({ links }));
    await view.user.click(await screen.findByTestId(open));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(/^The profile locked before the app opened\.?\s*Unlock it, then open the app again\.$/);
  });
});

it("is said in the app's language (Portuguese), not the host's English", async () => {
  const view = renderApp(<PeerServices peerPubKey="peer" onManage={() => {}} />, { language: "pt" });
  act(() => view.engine.update({ links }));
  await view.user.click(await screen.findByTestId("open-service"));
  const alert = await screen.findByRole("alert");
  expect(alert).not.toHaveTextContent(SERVICE_LOCKED);
  expect(alert).toHaveTextContent(/perfil/i);
});
