import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createIdentity, encodeGroupEntryLink } from "@ghostly/core";
import { TEST_MINTS } from "@ghostly/browser/shared/mints";
import { GroupLinkPanel } from "../../components/GroupLinkPanel";
import { MessageBubble } from "../../components/MessageBubble";
import { QRCodeDisplay } from "../../components/QRCode";
import { LinkActions } from "../../components/chat/LinkQrDialog";
import { CashuWallet } from "../../components/wallet/CashuWallet";
import { networkState } from "../../components/walletCardData";
import { servicesPlatform, type WalletPlatform, type WalletState } from "../../lib/platform";
import { copyText } from "../../lib/shareLink";
import type { ChatMessage } from "../../lib/types";
import { Wallet } from "../../pages/Wallet";
import { fakeEngine, groupView, linkView, walletView } from "../fakeEngine";
import { mint, REAL_MINT } from "../payments/fixtures";
import { renderApp } from "../render";

// covers: invite.copy, devices.enroll.invite, groups.link.share, wallet.cashu.export, wallet.instances.remove, wallet.cashu.receive-token, chat.paired.message-details

const INVITE = "https://ghostly.tools/#ghostly1secretinvite";
const TOKEN = "cashuB" + "o".repeat(40);
const message = (text: string, patch: Partial<ChatMessage> = {}): ChatMessage => ({ id: "peer_abc", text, sender: "peer", timestamp: 1_700_000_000_000, ...patch });

/**
 * A secret copied (an invite, a device's link, a group's link, ecash) goes through the host's sensitive copy where it
 * has one (the Android app: the system's copy preview shows dots, keyboards keep no history of it). Everything else is
 * copied by the page, as before; and where the host has no such copy (desktop, web) a secret is too.
 */
describe("a secret is copied as one where the platform marks it", () => {
  let secret: ReturnType<typeof vi.fn<(text: string) => Promise<void>>>;
  let page: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    secret = vi.fn(async (_text: string) => {});
    fakeEngine.copySecret = secret;
  });
  afterEach(() => { fakeEngine.copySecret = undefined; });
  /** Spied after the render: user-event puts its own clipboard in place when it starts. */
  const watchPage = () => { page = vi.spyOn(navigator.clipboard, "writeText") as unknown as ReturnType<typeof vi.fn>; };

  it("the invite card's and Add device's Copy", async () => {
    const { user } = renderApp(<QRCodeDisplay value={INVITE} />);
    watchPage();
    await user.click(screen.getByRole("button", { name: /copy/i }));
    await waitFor(() => expect(secret).toHaveBeenCalledWith(INVITE));
    expect(page).not.toHaveBeenCalled();
  });

  it("a card's link and its QR dialog's Copy", async () => {
    const { user } = renderApp(<LinkActions name="card" title="Invite" url={INVITE} />);
    watchPage();
    await user.click(screen.getByTestId("card-copy"));
    await waitFor(() => expect(secret).toHaveBeenCalledTimes(1));
    await user.click(screen.getByTestId("card-qr"));
    await user.click(screen.getByTestId("link-qr-copy"));
    await waitFor(() => expect(secret).toHaveBeenCalledTimes(2));
    expect(secret).toHaveBeenLastCalledWith(INVITE);
    expect(page).not.toHaveBeenCalled();
  });

  it("a group's link", async () => {
    const id = "AbCdEfGhIjKlMnOpQrStUv";
    const group = groupView({ id, status: "active", epoch: 1, isAdmin: true, entryLink: encodeGroupEntryLink({ g: id, host: createIdentity().pubKeyZ32 }) });
    const { user } = renderApp(<GroupLinkPanel group={group} large />);
    watchPage();
    await user.click(screen.getByTestId("group-link-copy"));
    await waitFor(() => expect(secret).toHaveBeenCalledWith(expect.stringContaining("/#/join/")));
    expect(page).not.toHaveBeenCalled();
  });

  it("Cashu's Copy backup", async () => {
    const state = networkState(walletView({ mode: "testnet", mints: [mint(TEST_MINTS[0], 5_000)], balance: 5_000 }) as WalletState, "testnet");
    const wallet: WalletPlatform = Object.assign(Object.create(servicesPlatform!.wallet), { exportTokens: async () => [{ token: "cashuBone", mint: TEST_MINTS[0], amount: 1 }, { token: "cashuBtwo", mint: TEST_MINTS[0], amount: 2 }] });
    const { user } = renderApp(<CashuWallet wallet={wallet} state={state} rail="cashu" onOpenCashu={() => {}} />);
    watchPage();
    await user.click(screen.getByRole("button", { name: "Copy backup" }));
    await waitFor(() => expect(secret).toHaveBeenCalledWith("cashuBone\ncashuBtwo"));
    expect(page).not.toHaveBeenCalled();
  });

  it("Remove wallet's copy of the ecash", async () => {
    const app = renderApp(<Wallet />);
    app.engine.update({ wallet: walletView({ mints: [mint(REAL_MINT, 21_000)], balance: 21_000 }) });
    await app.user.click(await screen.findByTestId("wallet-card-cashu-mainnet"));
    await app.user.click(await screen.findByTestId("wallet-remove"));
    app.engine.on("walletExport", () => [{ mint: REAL_MINT, token: "cashuBfixture", amount: 21_000 }]);
    watchPage();
    await app.user.click(screen.getByTestId("wallet-remove-copy-tokens"));
    expect(await screen.findByTestId("wallet-remove-notice")).toHaveTextContent("Ecash copied");
    expect(secret).toHaveBeenCalledWith("cashuBfixture");
    expect(page).not.toHaveBeenCalled();
  });

  it("an ecash token's card's Copy; a payment request's stays plain", async () => {
    fakeEngine.on("walletInspectCashu", () => ({ inspection: { kind: "token", amount: 21, unit: "sat", mint: "https://testnut.cashu.space", accepted: true } }));
    const { user, unmount } = renderApp(<MessageBubble message={message(`here you go ${TOKEN}`)} peerPubKey="peer" />);
    const card = await screen.findByTestId("cashu-token-bubble");
    watchPage();
    await user.click(within(card).getByRole("button", { name: "Copy" }));
    await waitFor(() => expect(secret).toHaveBeenCalledWith(TOKEN));
    expect(page).not.toHaveBeenCalled();
    unmount();

    const request = "creqA" + "o".repeat(40);
    fakeEngine.on("walletInspectCashu", () => ({ inspection: { kind: "request", amount: 21, unit: "sat", mints: ["https://testnut.cashu.space"] } }));
    const again = renderApp(<MessageBubble message={message(request)} peerPubKey="peer" />);
    const requestCard = await screen.findByTestId("cashu-request-bubble");
    watchPage();
    await again.user.click(within(requestCard).getByRole("button", { name: "Copy" }));
    await waitFor(() => expect(page).toHaveBeenCalledWith(request));
    expect(secret).toHaveBeenCalledTimes(1);
  });

  it("a message's Copy under a long press, when its words hold a token; other words stay plain", async () => {
    vi.useFakeTimers();
    try {
      const pressCopy = (text: string) => {
        const { container, unmount } = renderApp(<MessageBubble message={message(text)} peerPubKey="peer" onReact={() => {}} />);
        watchPage();
        const row = container.querySelector<HTMLElement>("[data-message-row]")!;
        fireEvent.pointerDown(row, { pointerType: "touch", button: 0, clientX: 20, clientY: 20, pointerId: 1 });
        act(() => { vi.advanceTimersByTime(600); });
        fireEvent.pointerUp(row, { pointerType: "touch", clientX: 20, clientY: 20, pointerId: 1 });
        fireEvent.click(screen.getByTestId("reaction-bar-copy"));
        return unmount;
      };
      // The wallet does not read it here: the text stays a text, as it does until the wallet answers.
      fakeEngine.on("walletInspectCashu", () => ({ inspection: null }));
      pressCopy(`take this ${TOKEN} before lunch`)();
      await act(async () => {});
      expect(secret).toHaveBeenCalledWith(`take this ${TOKEN} before lunch`);
      expect(page).not.toHaveBeenCalled();
      pressCopy("lunch at noon?");
      await act(async () => {});
      expect(page).toHaveBeenCalledWith("lunch at noon?");
      expect(secret).toHaveBeenCalledTimes(1);
    } finally { vi.useRealTimers(); }
  });

  it("a message's details: an edit's earlier text that held a token, and Copy all; its ids stay plain", async () => {
    fakeEngine.setState({ links: [linkView({ id: "link-1", peerPubKeyZ32: "peer" })] });
    fakeEngine.on("walletInspectCashu", () => ({ inspection: null }));
    const edited = message("sorry, wrong paste", { edit: { seq: 1, at: 1_700_000_100_000, history: [{ at: 1_700_000_000_000, text: `here ${TOKEN}` }] } });
    const { user } = renderApp(<MessageBubble message={edited} peerPubKey="peer" onDelete={() => {}} />);
    await user.keyboard("{Control>}");
    await user.dblClick(screen.getByText("sorry, wrong paste"));
    await user.keyboard("{/Control}");
    const details = await screen.findByTestId("message-details");
    watchPage();
    const before = [...details.querySelectorAll<HTMLElement>("[data-testid=message-details-row]")].find((row) => row.dataset.value === `here ${TOKEN}`)!;
    await user.click(within(before).getByRole("button"));
    await waitFor(() => expect(secret).toHaveBeenCalledWith(`here ${TOKEN}`));
    await user.click(screen.getByTestId("message-details-copy-all"));
    await waitFor(() => expect(secret).toHaveBeenCalledTimes(2));
    expect(secret.mock.lastCall![0]).toContain(TOKEN);
    expect(page).not.toHaveBeenCalled();
    const id = [...details.querySelectorAll<HTMLElement>("[data-testid=message-details-row]")].find((row) => row.dataset.value === "peer_abc")!;
    await user.click(within(id).getByRole("button"));
    await waitFor(() => expect(page).toHaveBeenCalledWith("peer_abc"));
    expect(secret).toHaveBeenCalledTimes(2);
  });

  it("a code block's and a long key's Copy, when they hold a seed or a key; other code stays plain", async () => {
    const seed = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
    const { user, unmount } = renderApp(<MessageBubble message={message("```\n" + seed + "\n```")} peerPubKey="peer" />);
    watchPage();
    await user.click(screen.getByTestId("rich-codeblock-copy"));
    await waitFor(() => expect(secret).toHaveBeenCalledWith(seed));
    unmount();

    // BIP32's first test vector: a public example, not a key anyone holds.
    const xprv = "xprv9s21ZrQH143K3QTDL4LXw2F7HEK3wJUD2nW2nRk4stbPy6cq3jPPqjiChkVvvNKmPGJxWUtg6LnF5kejMRNNU3TGtRBeJgk33yuGBxrMPHi";
    const blob = renderApp(<MessageBubble message={message(`my key ${xprv}`)} peerPubKey="peer" />);
    await blob.user.click(screen.getByTestId("rich-blob-copy"));
    await waitFor(() => expect(secret).toHaveBeenCalledWith(xprv));
    expect(page).not.toHaveBeenCalled();
    blob.unmount();

    const plain = renderApp(<MessageBubble message={message("```py\nprint('hi')\n```")} peerPubKey="peer" />);
    watchPage();
    await plain.user.click(screen.getByTestId("rich-codeblock-copy"));
    await waitFor(() => expect(page).toHaveBeenCalledWith("print('hi')"));
    expect(secret).toHaveBeenCalledTimes(2);
  });

  it("a code block's Copy that the platform refuses to mark copies nothing and says so", async () => {
    secret.mockRejectedValue(new Error("refused"));
    const { user } = renderApp(<MessageBubble message={message("```\nabandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about\n```")} peerPubKey="peer" />);
    watchPage();
    await user.click(screen.getByTestId("rich-codeblock-copy"));
    await waitFor(() => expect(screen.getByTestId("rich-codeblock-copy")).toHaveTextContent("Not copied"));
    expect(page).not.toHaveBeenCalled();
  });

  it("a long key's refused Copy is named by the words it shows, and sends no one below for a key beside it", async () => {
    secret.mockRejectedValue(new Error("refused"));
    const xprv = "xprv9s21ZrQH143K3QTDL4LXw2F7HEK3wJUD2nW2nRk4stbPy6cq3jPPqjiChkVvvNKmPGJxWUtg6LnF5kejMRNNU3TGtRBeJgk33yuGBxrMPHi";
    const { user } = renderApp(<MessageBubble message={message(`my key ${xprv}`)} peerPubKey="peer" />);
    await user.click(screen.getByTestId("rich-blob-copy"));
    const copy = screen.getByTestId("rich-blob-copy");
    await waitFor(() => expect(copy).toHaveTextContent("Not copied"));
    // A voice control's "click Not copied" finds it: the name starts with the words on it.
    expect(copy.getAttribute("aria-label")).toMatch(/^Not copied\b/);
    expect(copy.getAttribute("aria-label")).not.toMatch(/below/);
    expect(copy.title).toBe(copy.getAttribute("aria-label"));
  });

  it("anything else is copied by the page, unmarked", async () => {
    const { user } = renderApp(<button onClick={() => void copyText("hello there")}>Copy text</button>);
    watchPage();
    await user.click(screen.getByRole("button", { name: "Copy text" }));
    await waitFor(() => expect(page).toHaveBeenCalledWith("hello there"));
    expect(secret).not.toHaveBeenCalled();
  });

  it("where the host has no sensitive copy (desktop, web), a secret is copied by the page as before", async () => {
    fakeEngine.copySecret = undefined;
    const { user } = renderApp(<QRCodeDisplay value={INVITE} />);
    watchPage();
    await user.click(screen.getByRole("button", { name: /copy/i }));
    await waitFor(() => expect(page).toHaveBeenCalledWith(INVITE));
  });
});
