import { act, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { LinkView } from "@ghostly/browser/shared/types";
import { ChatServicesDialog } from "../../components/ChatServicesDialog";
import { PeerServices } from "../../components/PeerServices";
import { saveSession } from "../../lib/storage";
import type { ChatSession } from "../../lib/types";
import { Services } from "../../pages/Services";
import { fakeEngine, linkView } from "../fakeEngine";
import { renderApp } from "../render";

// covers: settings.network.relay-only, services.open

/**
 * A contact's app refused while Hide my IP from contacts is on (the web app's host, the extension's background): one
 * short line, and the why (a browser could show the app's servers your IP; the desktop app opens it) behind its ⓘ, in
 * the app's language. With the setting off the app opens, and no line shows.
 */
const REFUSALS = {
  web: { thrown: "A contact's app does not open in the web app while Hide my IP from contacts is on", line: "A contact's app does not open on the web while Hide my IP is on" },
  extension: { thrown: "A contact's app does not open in the browser extension while Hide my IP from contacts is on", line: "A contact's app does not open here while Hide my IP is on" },
};
const WHY = /could show its servers your IP\. The desktop app opens it safely/;

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
});
afterEach(() => {
  fakeEngine.openService = openService;
  fakeEngine.features = { ...fakeEngine.features, shareLocalServices: false, openServices: false };
});

describe.each(PLACES)("Hide my IP's refusal in $name", ({ ui, open }) => {
  it.each(Object.entries(REFUSALS))("on the %s: one short line, the why and the desktop app behind its ⓘ", async (_runner, refusal) => {
    fakeEngine.openService = async () => { throw new Error(refusal.thrown); };
    const view = renderApp(ui);
    act(() => view.engine.update({ links }));
    await view.user.click(await screen.findByTestId(open));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(new RegExp(`^${refusal.line}$`));
    expect(alert).not.toHaveTextContent(WHY);

    await view.user.click(within(alert).getByRole("button", { name: "More info" }));
    expect(alert).toHaveTextContent(WHY);
    // Said in the app's language, not as the engine's English detail (marked lang="en", left to right).
    const why = within(alert).getByText(WHY);
    expect(why.closest("[lang=en]")).toBe(document.documentElement);
    expect(within(alert).queryByRole("button", { name: "Copy" })).not.toBeInTheDocument();
  });

  it("with the setting off the app opens, and no line shows", async () => {
    let opened = 0;
    fakeEngine.openService = async () => { opened++; };
    const view = renderApp(ui);
    act(() => view.engine.update({ links }));
    await view.user.click(await screen.findByTestId(open));
    expect(opened).toBe(1);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});

it("the why is in the app's language (Arabic)", async () => {
  fakeEngine.openService = async () => { throw new Error(REFUSALS.web.thrown); };
  const view = renderApp(<PeerServices peerPubKey="peer" onManage={() => {}} />, { language: "ar" });
  act(() => view.engine.update({ links }));
  await view.user.click(await screen.findByTestId("open-service"));
  const alert = await screen.findByRole("alert");
  await view.user.click(within(alert).getByRole("button"));
  expect(alert).not.toHaveTextContent(/[A-Za-z]{4}/);
});
