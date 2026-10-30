import { act, screen, waitFor } from "@testing-library/react";
import { useLocation } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { ContactAskHost } from "../../components/requests/ContactAskDialog";
import { JoinDialog } from "../../components/JoinDialog";
import { offerContactLink } from "../../lib/contactLinks";
import { findSession } from "../../lib/storage";
import { linkView } from "../fakeEngine";
import { renderApp } from "../render";

const CODE = "ghostly1rqqqsyqcyq5rqwzqfpg9scrgwpugpzysnzs23v9ccrydpk8qarc0s0her5u";
function Where() { return <p data-testid="where">{useLocation().pathname}</p>; }

/** Someone's contact link, opened or pasted (WISP 8xx): a request form, never a chat by itself. */
describe("Asking through a contact link", () => {
  it("sends nothing until Send, then the chat made for the request is in the chat list and open", async () => {
    const { engine, user } = renderApp(<><ContactAskHost /><Where /></>);
    const PEER = "y".repeat(52), SEED = "C".repeat(43);
    engine.on("askContactLink", () => { engine.update({ links: [linkView({ id: "asked-1", peerPubKeyZ32: PEER })] }); return { chatId: "asked-1" }; });
    engine.on("exportLinks", () => [{ profile: "paired-chat/1", seedB64: SEED, peerPubKeyZ32: PEER, encKeyB64: "D".repeat(43), createdAt: 5, inviteCode: "ghostly1p…", label: "Alice's site" }]);
    act(() => offerContactLink(`https://ghostly.tools/#${CODE}`));
    expect(await screen.findByTestId("contact-ask")).toBeInTheDocument();
    expect(engine.calls).toEqual([]);
    expect(screen.getByTestId("contact-ask-send")).toBeDisabled();
    await user.clear(screen.getByTestId("contact-ask-name"));
    await user.type(screen.getByTestId("contact-ask-name"), "Kevin");
    await user.type(screen.getByTestId("contact-ask-text"), "Hi, I read your post.");
    await user.type(screen.getByTestId("contact-ask-label"), "Alice's site");
    await user.click(screen.getByTestId("contact-ask-send"));
    expect(engine.callsTo("askContactLink")).toEqual([{ code: CODE, name: "Kevin", text: "Hi, I read your post.", label: "Alice's site" }]);
    await waitFor(() => expect(screen.getByTestId("where")).toHaveTextContent(`/chat/${findSession(SEED, PEER)?.id}`));
    expect(screen.queryByTestId("contact-ask")).not.toBeInTheDocument();
  });

  it("counts the message's bytes and refuses past 200, and shows the engine's refusal", async () => {
    const { engine, user } = renderApp(<ContactAskHost />);
    engine.on("askContactLink", () => { throw new Error("This is your contact link."); });
    act(() => offerContactLink(CODE));
    await user.type(await screen.findByTestId("contact-ask-name"), "Me");
    await user.type(screen.getByTestId("contact-ask-text"), "é".repeat(101));
    expect(screen.getByTestId("contact-ask-left")).toHaveTextContent("-2 bytes left");
    expect(screen.getByTestId("contact-ask-send")).toBeDisabled();
    await user.clear(screen.getByTestId("contact-ask-text"));
    await user.type(screen.getByTestId("contact-ask-text"), "hi");
    await user.click(screen.getByTestId("contact-ask-send"));
    expect(await screen.findByTestId("contact-ask-error")).toHaveTextContent("This is your contact link.");
  });

  it("a contact link pasted in Join goes to the request form, not to a chat", async () => {
    let closed = false;
    const { user } = renderApp(<><JoinDialog onClose={() => { closed = true; }} onJoin={() => { throw new Error("joined"); }} /><ContactAskHost /></>);
    await navigator.clipboard.writeText(`https://ghostly.tools/#${CODE}`);
    await user.click(screen.getByRole("button", { name: /paste/i }));
    expect(await screen.findByTestId("contact-ask")).toBeInTheDocument();
    expect(closed).toBe(true);
  });
});
