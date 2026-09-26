import { act, screen, waitFor, within } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it } from "vitest";
import type { LinkView, ServiceView } from "@ghostly/browser/shared/types";
import { ChatServicesDialog } from "../../components/ChatServicesDialog";
import { MessageInput } from "../../components/MessageInput";
import { composerServices } from "../../components/composer/servicesRow";
import { LockScreenProvider } from "../../contexts/LockScreenContext";
import { useI18n } from "../../contexts/I18nContext";
import { useServicesPlatform } from "../../hooks/useServicesPlatform";
import { fakeEngine, linkView } from "../fakeEngine";
import { renderApp } from "../render";

// covers: app.composer.attach, services.share, services.web-unavailable, services.paired.negotiate

type Pairing = NonNullable<LinkView["pairing"]>;
const ready = { status: "ready", transport: "iroh/1" } as Pairing;
const both = { mine: ["calls/1", "services/1"], peer: ["calls/1", "services/1"] };
/** A paired chat with Ana, live, both apps offering services/1. */
const live = (patch: Partial<LinkView> = {}) => linkView({ profile: "paired-chat/1", pairing: ready, sessionOffers: both,
  capabilities: { files: true, payments: false, services: true }, ...patch });
const app = (patch: Partial<ServiceView> = {}): ServiceView => ({ id: "atlas", name: "Atlas", target: "http://localhost:3400", enabled: true, createdAt: 0, requests: 0, ...patch });

/** What the extension and the desktop app can do; the web app does neither. */
function localApps(on: boolean) {
  fakeEngine.features = { ...fakeEngine.features, shareLocalServices: on, openServices: on };
}
afterEach(() => localApps(false));

/** The chat's composer and its Services dialog, wired as Chat.tsx wires them. */
function ChatWithAna() {
  const { t } = useI18n();
  const platform = useServicesPlatform();
  const [open, setOpen] = useState(false);
  return (
    <LockScreenProvider>
      <MessageInput onSend={async () => null} identities={{ peerKey: "peer", contact: "Ana" }}
        services={composerServices(t, platform, "peer", "Ana", () => setOpen(true))} />
      {open && <ChatServicesDialog peerPubKey="peer" name="Ana" onClose={() => setOpen(false)} />}
    </LockScreenProvider>
  );
}

async function openPlus(user: ReturnType<typeof renderApp>["user"]) {
  await user.click(screen.getByTestId("composer-more"));
  return screen.getByTestId("composer-services");
}

describe("the composer's Shared services row", () => {
  it("sits beside Payment and Identity with a green globe of its own, only in a chat the platform knows the contact of", async () => {
    localApps(true);
    const view = renderApp(<ChatWithAna />);
    await view.user.click(screen.getByTestId("composer-more"));
    // No chat with this contact yet: nothing to share apps in.
    expect(screen.queryByTestId("composer-services")).not.toBeInTheDocument();
    await view.user.keyboard("{Escape}");

    act(() => view.engine.update({ links: [live()] }));
    const row = await openPlus(view.user);
    const rows = within(screen.getByTestId("composer-menu")).getAllByRole("button");
    expect(rows.map((r) => r.dataset.action)).toEqual(["identity", "services"]);
    expect(row).toHaveTextContent(/^Shared services$/);
    expect(row).toBeEnabled();
    expect(row.querySelector(".composer-menu-icon")).toHaveAttribute("data-action", "services");
    expect(row.querySelector(".composer-menu-icon svg path")).toHaveAttribute("fill-rule", "evenodd");
  });

  it("opens the chat's apps with a contact who shares nothing, for a first share, and the focus comes back to the +", async () => {
    localApps(true);
    const view = renderApp(<ChatWithAna />);
    view.engine.on("setServiceShared", () => undefined);
    act(() => view.engine.update({ links: [live()], services: [app()] }));
    // Nothing shared either way: nothing on hover, and no strip in the chat would offer Manage.
    const row = await openPlus(view.user);
    expect(row).not.toHaveAttribute("title");

    await view.user.click(row);
    expect(screen.queryByTestId("composer-menu")).not.toBeInTheDocument();
    const dialog = screen.getByTestId("chat-services");
    expect(within(dialog).getByRole("heading", { name: "Apps with Ana" })).toBeInTheDocument();
    expect(screen.queryByTestId("chat-services-unavailable")).not.toBeInTheDocument();
    await view.user.click(within(dialog).getByTestId("chat-service-toggle"));
    expect(view.engine.callsTo("setServiceShared")).toEqual([{ serviceId: "atlas", peerPubKeyZ32: "peer", shared: true }]);

    await view.user.keyboard("{Escape}");
    expect(screen.queryByTestId("chat-services")).not.toBeInTheDocument();
    expect(screen.getByTestId("composer-more")).toHaveFocus();
  });

  it("says on hover how many apps are shared in this chat, either way, not counting a paused one, in one line", async () => {
    localApps(true);
    const view = renderApp(<ChatWithAna />);
    act(() => view.engine.update({
      links: [live({ peerServices: [{ id: "wiki", type: "http", name: "Wiki" }, { id: "voice", type: "voice" }] })],
      services: [app({ sharedWith: ["peer"] }), app({ id: "paused", enabled: false, sharedWith: ["peer"] }), app({ id: "other", sharedWith: ["someone-else"] })],
    }));
    const row = await openPlus(view.user);
    expect(row).toBeEnabled();
    expect(row).toHaveAttribute("title", "2 shared in this chat");
    expect(row).toHaveTextContent(/^Shared services$/);
  });

  it("still opens while apps cannot travel yet, saying why, so an app can be granted before the chat is live", async () => {
    localApps(true);
    const view = renderApp(<ChatWithAna />);
    act(() => view.engine.update({ links: [live({ dataLink: "idle", pairing: { status: "connecting" } as Pairing, sessionOffers: { mine: both.mine, peer: null },
      capabilities: { files: false, payments: false, services: false } })], services: [app()] }));
    let row = await openPlus(view.user);
    expect(row).toBeEnabled();
    expect(row).toHaveAttribute("title", "Shared services open while you are connected live.");
    expect(row).toHaveTextContent(/^Shared services$/);
    await view.user.click(row);
    expect(screen.getByTestId("chat-service-toggle")).toBeInTheDocument();
    await view.user.keyboard("{Escape}");

    // Live, with a contact whose app has not said what it offers: an update is what it takes.
    act(() => view.engine.update({ links: [live({ sessionOffers: { mine: both.mine, peer: null }, capabilities: { files: true, payments: false, services: false } })] }));
    row = await openPlus(view.user);
    expect(row).toBeEnabled();
    expect(row).toHaveAttribute("title", "Ana needs an updated Ghostly to open shared services.");
  });

  it("is greyed with the reason where nothing in it can be chosen: the contact's app cannot open apps", async () => {
    localApps(true);
    const view = renderApp(<ChatWithAna />);
    act(() => view.engine.update({ links: [live({ sessionOffers: { mine: both.mine, peer: ["calls/1"] }, capabilities: { files: true, payments: false, services: false } })] }));
    const row = await openPlus(view.user);
    expect(row).toBeDisabled();
    expect(row).toHaveAttribute("title", "Ana's app cannot open or share apps (the web app cannot reach local apps).");
    expect(row).toHaveTextContent(/^Shared services$/);
    await view.user.click(row);
    expect(screen.queryByTestId("chat-services")).not.toBeInTheDocument();
  });

  it("is greyed on the web, which can neither share a local app nor open one", async () => {
    const view = renderApp(<ChatWithAna />);
    act(() => view.engine.update({ links: [linkView({ profile: "paired-chat/1", pairing: ready, sessionOffers: { mine: ["calls/1"], peer: both.peer } })] }));
    const row = await openPlus(view.user);
    expect(row).toBeDisabled();
    expect(row).toHaveAttribute("title", "Needs the Ghostly extension or desktop app");
    expect(row).toHaveTextContent(/^Shared services$/);
    // The other rows are not held back by it.
    expect(screen.getByTestId("composer-identities-button")).toBeEnabled();
  });

  it("reads in the app's language", async () => {
    localApps(true);
    const view = renderApp(<ChatWithAna />, { language: "pt" });
    act(() => view.engine.update({ links: [live()], services: [app({ sharedWith: ["peer"] })] }));
    const row = await openPlus(view.user);
    await waitFor(() => expect(row).toHaveTextContent("Apps compartilhados1 compartilhado(s) nesta conversa"));
  });
});
