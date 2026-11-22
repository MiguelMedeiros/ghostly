import { act, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { NostrDraft, NostrDraftRequest, NostrPublishResult } from "@ghostly/browser/nostr/types";
import { NostrPublishDialog } from "../../components/nostr/NostrPublishDialog";
import { signNostrDraft } from "../../lib/nostr";
import { fakeEngine } from "../fakeEngine";
import { renderApp } from "../render";

// covers: nostr.social.publish, app.composer.secret-guard

/*
 * A keyboard's focus and a screen reader through a Nostr publish: Send anyway on the secret question gives the focus
 * back to Sign and publish as its work starts, and a disabled button takes none, so it fell to the page while it
 * signed and stayed there on a refusal. Once published, the buttons went with the focus in them and nothing said so.
 */

vi.mock("../../lib/nostr", () => ({
  nostrSignerChoices: () => [{ id: "nip07", label: "Browser extension (NIP-07)" }],
  signNostrDraft: vi.fn(async () => ({ id: "signed" })),
}));

/** happy-dom has no <dialog> modal; the dialog only needs to open. */
HTMLDialogElement.prototype.showModal ??= function (this: HTMLDialogElement) { this.open = true; };

afterEach(() => { vi.mocked(signNostrDraft).mockReset(); vi.mocked(signNostrDraft).mockImplementation(async () => ({ id: "signed" }) as never); });

const SEED = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";

function open(content: string, publish: () => Promise<NostrPublishResult>) {
  fakeEngine.on("nostrDraft", async () => ({ draftId: "d1", subject: "npub1me", template: { kind: 1, created_at: 1, tags: [], content }, notice: "Sent to wss://relay.example.", summary: "Post a note", relays: ["wss://relay.example"] }) as NostrDraft);
  fakeEngine.on("nostrPublish", publish);
  const request: NostrDraftRequest = { subject: "npub1me", action: "note", content };
  return renderApp(<NostrPublishDialog request={request} onClose={() => {}} />);
}

const confirm = () => screen.getByTestId("nostr-publish-confirm");

describe("publishing on Nostr with the keys", () => {
  it("keeps the focus on Sign and publish after Send anyway, while it signs and when it is refused", async () => {
    let sign!: () => void;
    vi.mocked(signNostrDraft).mockImplementation(() => new Promise((resolve) => { sign = () => resolve({ id: "signed" } as never); }));
    const { user } = open(`my backup: ${SEED}`, async () => { throw new Error("No relay accepted the event"); });
    (await screen.findByTestId("nostr-publish-confirm")).focus();
    await user.keyboard("{Enter}");
    within(await screen.findByTestId("secret-guard")).getByTestId("secret-guard-send").focus();
    await user.keyboard("{Enter}");
    await waitFor(() => expect(screen.queryByTestId("secret-guard")).toBeNull());
    expect(document.activeElement).toBe(confirm());
    expect(confirm()).toHaveAttribute("aria-busy", "true");
    expect(confirm()).toHaveAttribute("aria-disabled", "true");

    await act(async () => sign());
    expect(await screen.findByRole("alert")).toHaveTextContent("No relay accepted the event");
    expect(document.activeElement).toBe(confirm());
    expect(confirm()).not.toHaveAttribute("aria-disabled");
  });

  it("once published, moves the focus to Done and says where it went", async () => {
    const { user } = open("good morning, nostr", async () => ({ accepted: ["wss://relay.example"], rejected: [] }));
    await screen.findByTestId("nostr-publish-confirm");
    const status = screen.queryByRole("status");
    (await screen.findByTestId("nostr-publish-confirm")).focus();
    await user.keyboard("{Enter}");
    await screen.findByTestId("nostr-publish-result");
    expect(document.activeElement).not.toBe(document.body);
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Done" }));
    // The same live region, there since the dialog opened: one added along with its words is often not read.
    expect(status).not.toBeNull();
    expect(screen.getByRole("status")).toBe(status);
    expect(status).toHaveTextContent("Published to wss://relay.example.");
  });
});
