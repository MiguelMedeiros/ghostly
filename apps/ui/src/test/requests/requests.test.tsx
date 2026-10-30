import { act, screen, waitFor } from "@testing-library/react";
import { useLocation } from "react-router-dom";
import { describe, expect, it } from "vitest";
import type { ContactLinkView, ContactRequestView } from "@ghostly/browser/shared/types";
import { Requests } from "../../pages/Requests";
import { SidebarRequests } from "../../components/requests/SidebarRequests";
import { renderApp } from "../render";
import { linkView } from "../fakeEngine";
import { findSession } from "../../lib/storage";


const link = (patch: Partial<ContactLinkView> = {}): ContactLinkView => ({
  code: "ghostly1rqqqsyqcyq5rqwzqfpg9scrgwpugpzysnzs23v9ccrydpk8qarc0s0her5u", link: "https://ghostly.tools/#ghostly1rqqqsyqcyq5rqwzqfpg9scrgwpugpzysnzs23v9ccrydpk8qarc0s0her5u",
  createdAt: 1, state: "open", waiting: 0, missed: 0, ...patch,
});
const request = (id: string, name: string, text: string): ContactRequestView => ({ id, name, text, receivedAt: Date.UTC(2026, 9, 16, 12), expires: Date.UTC(2026, 9, 23, 12) });

function Where() { return <p data-testid="where">{useLocation().pathname}</p>; }

/** Requests (WISP 8xx): what the contact link took, apart from the chats, with Accept and Decline. */
describe("Requests", () => {
  it("the way there shows only with a contact link or requests, with how many wait", () => {
    const { engine } = renderApp(<SidebarRequests active={false} onOpen={() => {}} />);
    expect(screen.queryByTestId("sidebar-requests")).not.toBeInTheDocument();
    act(() => engine.update({ contactLink: link() }));
    expect(screen.getByTestId("sidebar-requests")).toHaveTextContent("Requests");
    expect(screen.queryByTestId("sidebar-requests-count")).not.toBeInTheDocument();
    act(() => engine.update({ contactRequests: [request("a", "Kevin", "Hi"), request("b", "Ana", "Olá")] }));
    expect(screen.getByTestId("sidebar-requests-count")).toHaveTextContent("2");
    expect(screen.getByTestId("sidebar-requests")).toHaveAccessibleName("Requests, 2 waiting");
  });

  it("looks for requests when opened, lists them, and accept opens the chat it started", async () => {
    const { engine, user } = renderApp(<><Requests /><Where /></>, { route: "/requests" });
    engine.on("contactLinkShown", () => undefined);
    const PEER = "y".repeat(52), SEED = "A".repeat(43), KEY = "B".repeat(43);
    engine.on("acceptContactRequest", () => { engine.update({ links: [linkView({ id: "chat-1", peerPubKeyZ32: PEER })] }); return { linkId: "chat-1" }; });
    engine.on("exportLinks", () => [{ profile: "paired-chat/1", seedB64: SEED, peerPubKeyZ32: PEER, encKeyB64: KEY, createdAt: 5, label: "Kevin" }]);
    act(() => engine.update({ contactLink: link({ waiting: 1 }), contactRequests: [request("asker-1", "Kevin", "I read your site.")] }));
    await waitFor(() => expect(engine.callsTo("contactLinkShown")).toHaveLength(1));
    expect(screen.getByTestId("request-name")).toHaveTextContent("Kevin");
    expect(screen.getByTestId("request-text")).toHaveTextContent("I read your site.");
    expect(screen.getByTestId("requests-page")).toHaveTextContent("nobody checked them");
    await user.click(screen.getByTestId("request-accept"));
    expect(engine.callsTo("acceptContactRequest")).toEqual([{ id: "asker-1" }]);
    // The chat the engine made is taken into the app's chat list, named as the requester asked, and opened.
    await waitFor(() => expect(findSession(SEED, PEER)).toBeTruthy());
    expect(findSession(SEED, PEER)?.label).toBe("Kevin");
    await waitFor(() => expect(screen.getByTestId("where")).toHaveTextContent(`/chat/${findSession(SEED, PEER)!.id}`));
  });

  it("decline says nothing back, and an error stays on the page", async () => {
    const { engine, user } = renderApp(<Requests />, { route: "/requests" });
    engine.on("contactLinkShown", () => undefined);
    let fail = true;
    engine.on("declineContactRequest", () => { if (fail) throw new Error("This request is no longer waiting"); });
    act(() => engine.update({ contactLink: link(), contactRequests: [request("asker-2", "Mallory", "let me in")] }));
    await user.click(screen.getByTestId("request-decline"));
    expect(await screen.findByTestId("requests-error")).toHaveTextContent("no longer waiting");
    fail = false;
    await user.click(screen.getByTestId("request-decline"));
    expect(engine.callsTo("declineContactRequest")).toEqual([{ id: "asker-2" }, { id: "asker-2" }]);
  });

  it("says when the link is busy and how many tried, and what to do with no link", () => {
    const { engine } = renderApp(<Requests />, { route: "/requests" });
    engine.on("contactLinkShown", () => undefined);
    act(() => engine.update({ contactLink: undefined, contactRequests: [] }));
    expect(screen.getByTestId("requests-empty")).toHaveTextContent("Make one in Settings");
    act(() => engine.update({ contactLink: link({ state: "busy", missed: 7 }) }));
    expect(screen.getByTestId("requests-busy")).toHaveTextContent("Too many requests");
    expect(screen.getByTestId("requests-missed")).toHaveTextContent("7 more people");
  });
});
