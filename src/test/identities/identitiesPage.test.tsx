import { act, screen, within } from "@testing-library/react";
import { Route, Routes, useLocation } from "react-router-dom";
import { describe, expect, it } from "vitest";
import type { LinkView } from "@ghostly/browser/shared/types";
import { AccountBar } from "../../components/AccountBar";
import { MobileTabBar } from "../../components/MobileTabBar";
import { ChatIdentitiesDialog } from "../../components/identities/ChatIdentitiesDialog";
import { daysLeft, expiringSoon, identityAttention, markIdentityNewsSeen, unseenAttention } from "../../lib/identities";
import { saveSession } from "../../lib/storage";
import type { ChatSession } from "../../lib/types";
import { Identities } from "../../pages/Identities";
import { Profile } from "../../pages/Profile";
import { engineState, fakeEngine, linkView } from "../fakeEngine";
import { renderApp } from "../render";
import { DAY, identitiesView, now, proofView, receivedView, sharedView } from "./views";

// covers: proofs.page, proofs.expiry, app.navigation

function Where() {
  return <p data-testid="where">{useLocation().pathname}</p>;
}
const withWhere = (ui: React.ReactElement) => <>{ui}<Routes><Route path="*" element={<Where />} /></Routes></>;

/** A paired chat with Alice, in the chat list and in the engine. */
function alice(patch: Partial<LinkView> = {}): LinkView {
  saveSession({ id: "chat-alice", mySeedB64: "seed", peerPubKeyB64: "peer", encKeyB64: "key", messages: [], createdAt: 0, label: "Alice" } as ChatSession);
  return linkView({ identities: identitiesView(), ...patch });
}

describe("what needs attention about identities", () => {
  it("a proof is expiring in its last week, or its last quarter when it was made for less than a month", () => {
    const t = now();
    expect(expiringSoon({ issuedAt: t - 25 * DAY, expiresAt: t + 5 * DAY }, t)).toBe(true);
    expect(expiringSoon({ issuedAt: t - 20 * DAY, expiresAt: t + 10 * DAY }, t)).toBe(false);
    // Made for 7 days: not "expiring" on its first day, only in its last day and a half.
    expect(expiringSoon({ issuedAt: t, expiresAt: t + 7 * DAY }, t)).toBe(false);
    expect(expiringSoon({ issuedAt: t - 6 * DAY, expiresAt: t + DAY }, t)).toBe(true);
    // Expired is not expiring.
    expect(expiringSoon({ issuedAt: t - 30 * DAY, expiresAt: t - 1 }, t)).toBe(false);
    expect(daysLeft(t + 1, t)).toBe(1);
    expect(daysLeft(t + 2.5 * DAY, t)).toBe(3);
  });

  it("lists own proofs expiring or expired as lasting, and contacts' news as news", () => {
    const t = now();
    const state = engineState({
      identityProofs: [
        proofView({ id: "fine" }),
        proofView({ id: "soon", issuedAt: t - 27 * DAY, expiresAt: t + 3 * DAY }),
        proofView({ id: "gone", expiresAt: t - DAY }),
      ],
      links: [linkView({ identities: identitiesView({
        shared: [sharedView({ id: "fine", status: "rejected", at: 5 }), sharedView({ id: "soon", status: "accepted" })],
        received: [receivedView({ id: "r1", status: "revoked", checkedAt: 7 }), receivedView({ id: "r2", status: "unconfirmed", checkedAt: 8 }), receivedView({ id: "r3" })],
      }) })],
    });
    expect(identityAttention(state, t)).toEqual([
      { key: "expiring/soon", lasting: true },
      { key: "expired/gone", lasting: true },
      { key: "rejected/link-1/fine/5", lasting: false },
      { key: "revoked/link-1/r1", lasting: false },
      { key: "unconfirmed/link-1/r2", lasting: false },
    ]);
    expect(identityAttention(engineState(), t)).toEqual([]);
    expect(identityAttention(null, t)).toEqual([]);
  });

  it("news stops counting once seen, lasting items do not, and other news still counts", () => {
    const items = [{ key: "expired/a", lasting: true }, { key: "revoked/l/r", lasting: false }];
    expect(unseenAttention(items)).toHaveLength(2);
    markIdentityNewsSeen(items);
    expect(unseenAttention(items)).toEqual([{ key: "expired/a", lasting: true }]);
    expect(unseenAttention([{ key: "unconfirmed/l/r2", lasting: false }])).toHaveLength(1);
  });

  it("a contact's proof still unconfirmed at a later check is not news again", () => {
    const state = (checkedAt: number) => engineState({ links: [linkView({ identities: identitiesView({ received: [receivedView({ status: "unconfirmed", checkedAt })] }) })] });
    markIdentityNewsSeen(identityAttention(state(1)));
    expect(unseenAttention(identityAttention(state(2)))).toEqual([]);
  });
});

describe("the Identities page", () => {
  it("holds this profile's proofs with their status, and the way to add one", async () => {
    const t = now();
    const { user } = renderApp(<Identities />, { route: "/identities" });
    act(() => fakeEngine.update({ identityProofs: [proofView({ id: "a" }), proofView({ id: "b", subject: "example.net", issuedAt: t - 28 * DAY, expiresAt: t + 2 * DAY })] }));
    expect(screen.getByRole("heading", { name: "Identities" })).toBeInTheDocument();
    const [fine, soon] = screen.getAllByTestId("identity-proof");
    expect(within(fine).queryByTestId("identity-proof-expiring")).not.toBeInTheDocument();
    expect(within(soon).getByTestId("identity-proof-expiring")).toHaveTextContent("Expires in 2 days");
    expect(soon).toHaveTextContent("Add it again to renew it");
    await user.click(screen.getByTestId("identity-add"));
    expect(screen.getByRole("dialog", { name: "Add an identity" })).toBeInTheDocument();
  });

  it("names the contact who could not verify one of yours", () => {
    renderApp(<Identities />);
    act(() => fakeEngine.update({ identityProofs: [proofView({ id: "a" })], links: [alice({ identities: identitiesView({ shared: [sharedView({ id: "a", status: "rejected" })] }) })] }));
    expect(screen.getByTestId("identity-proof-refused")).toHaveTextContent("Not verified by Alice");
  });

  it("lists what contacts shared, what needs a look first, and opens that chat", async () => {
    const { user } = renderApp(withWhere(<Identities />));
    act(() => fakeEngine.update({ links: [alice({ identities: identitiesView({ received: [receivedView({ id: "ok" }), receivedView({ id: "bad", subject: "example.biz", status: "revoked" })] }) })] }));
    const rows = within(screen.getByTestId("identities-received")).getAllByTestId("identity-received");
    expect(rows.map(r => within(r).getByTestId("identity-received-status").textContent)).toEqual(["Revoked by its owner", "Verified"]);
    expect(rows[0]).toHaveTextContent("Alice");
    await user.click(within(rows[0]).getByTestId("identity-received-open"));
    expect(screen.getByTestId("where")).toHaveTextContent("/chat/chat-alice");
  });

  it("has no contacts' section when nobody shared anything, and shows Nostr once there is a Nostr key", () => {
    renderApp(<Identities />);
    act(() => fakeEngine.update({ links: [alice()] }));
    expect(screen.queryByTestId("identities-received")).not.toBeInTheDocument();
    expect(screen.queryByTestId("nostr-section")).not.toBeInTheDocument();
    act(() => fakeEngine.update({ nostr: { own: [{ subject: "a".repeat(64), npub: "npub1xyz", loading: false }] } as never }));
    expect(screen.getByTestId("nostr-section")).toBeInTheDocument();
  });

  it("marks contacts' news seen while it is open, so the dot goes; an expiring proof keeps it", () => {
    act(() => fakeEngine.update({ links: [alice({ identities: identitiesView({ received: [receivedView({ status: "unconfirmed" })] }) })] }));
    const bar = renderApp(<AccountBar />);
    expect(screen.getByTestId("identities-attention")).toBeInTheDocument();
    expect(screen.getByTestId("account-identities")).toHaveAccessibleName("Identities, needs attention");
    bar.unmount();

    const page = renderApp(<Identities />);
    page.unmount();
    renderApp(<AccountBar />);
    expect(screen.queryByTestId("identities-attention")).not.toBeInTheDocument();
    expect(screen.getByTestId("account-identities")).toHaveAccessibleName("Identities");

    const t = now();
    act(() => fakeEngine.update({ identityProofs: [proofView({ issuedAt: t - 28 * DAY, expiresAt: t + DAY })] }));
    expect(screen.getByTestId("identities-attention")).toBeInTheDocument();
  });
});

describe("the ways to Identities", () => {
  it("the account bar has Identities beside the wallet, and it opens the page", async () => {
    const { user } = renderApp(withWhere(<AccountBar />));
    const items = within(screen.getByRole("navigation", { name: "Account" })).getAllByRole("button");
    expect(items.map(b => b.dataset.testid)).toContain("account-identities");
    await user.click(screen.getByTestId("account-identities"));
    expect(screen.getByTestId("where")).toHaveTextContent("/identities");
  });

  it("the phone's tab bar has five tabs, Identities among them with its dot", async () => {
    act(() => fakeEngine.update({ identityProofs: [proofView({ expiresAt: now() - DAY })] }));
    const { user } = renderApp(withWhere(<MobileTabBar />), { language: "pt" });
    const tabs = within(screen.getByTestId("mobile-tabs")).getAllByRole("button");
    expect(tabs).toHaveLength(5);
    expect(screen.getByTestId("mobile-tab-identities")).toHaveTextContent("Identidades");
    expect(screen.getByTestId("mobile-tab-identities")).toHaveAccessibleName("Identidades, precisa de atenção");
    await user.click(screen.getByTestId("mobile-tab-identities"));
    expect(screen.getByTestId("where")).toHaveTextContent("/identities");
  });

  it("Profile links to the page where its identities went", async () => {
    const { user } = renderApp(withWhere(<Profile />));
    act(() => fakeEngine.update({ identityProofs: [proofView()] }));
    expect(screen.queryByTestId("identity-add")).not.toBeInTheDocument();
    expect(screen.getByTestId("profile-identities-link")).toHaveTextContent("Identities1");
    await user.click(screen.getByTestId("profile-identities-link"));
    expect(screen.getByTestId("where")).toHaveTextContent("/identities");
  });

  it("a chat's Identities dialog leads to the page", async () => {
    const onClose = () => {};
    const { user } = renderApp(withWhere(<ChatIdentitiesDialog peerKey="peer" name="Alice" onClose={onClose} />));
    act(() => fakeEngine.update({ links: [alice()] }));
    await user.click(screen.getByTestId("chat-identities-manage"));
    expect(screen.getByTestId("where")).toHaveTextContent("/identities");
  });
});
