import { screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { NostrDraft, NostrDraftRequest } from "@ghostly/browser/nostr/types";
import { NostrPublishDialog } from "../../components/nostr/NostrPublishDialog";
import { signNostrDraft } from "../../lib/nostr";
import { fakeEngine } from "../fakeEngine";
import { renderApp } from "../render";

// covers: app.composer.secret-guard, nostr.social.publish

/*
 * A Nostr note or profile is public and stays on the relays: text in it that looks like a secret (a seed, an nsec, a
 * key, a node login, ecash) asks first, as the chat composer does, before anything is signed or published.
 */

vi.mock("../../lib/nostr", () => ({
  nostrSignerChoices: () => [{ id: "nip07", label: "Browser extension (NIP-07)" }],
  signNostrDraft: vi.fn(async () => ({ id: "signed" })),
}));

/** happy-dom has no <dialog> modal; the dialog only needs to open. */
HTMLDialogElement.prototype.showModal ??= function (this: HTMLDialogElement) { this.open = true; };

afterEach(() => { vi.mocked(signNostrDraft).mockClear(); });

const SEED = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
/** Twelve seed words whose checksum fails: alone, still most of a seed. */
const SEED_TYPO = "abandon ability able about above absent absorb abstract absurd abuse access accident";
const NSEC ="nsec1vl029mgpspedva04g90vltkh6fvh240zqtv9k0t9af8935ke9laqsnlfe5";

function draftOf(kind: number, content: string): NostrDraft {
  return { draftId: "d1", subject: "npub1me", template: { kind, created_at: 1, tags: [], content }, notice: "Sent to wss://relay.example.", summary: "Post a note", relays: ["wss://relay.example"] };
}

async function publish(kind: number, content: string) {
  fakeEngine.on("nostrDraft", async () => draftOf(kind, content));
  fakeEngine.on("nostrPublish", async () => ({ accepted: ["wss://relay.example"], rejected: [] }));
  const request: NostrDraftRequest = kind === 1 ? { subject: "npub1me", action: "note", content } : { subject: "npub1me", action: "profile", fields: {} };
  const { user } = renderApp(<NostrPublishDialog request={request} onClose={() => {}} />);
  await user.click(await screen.findByTestId("nostr-publish-confirm"));
  return user;
}

describe("publishing on Nostr asks before a secret goes public", () => {
  it.each([
    ["a seed in a note", 1, `my backup: ${SEED}`, "mnemonic"],
    ["an nsec in a note", 1, `follow me ${NSEC}`, "nsec"],
    ["a seed in a profile's About, on lines of its own", 0, JSON.stringify({ name: "me", about: SEED.split(" ").join("\n") }), "mnemonic"],
    ["a profile's About that is nothing but seed words with a bad checksum", 0, JSON.stringify({ name: "Ana", about: SEED_TYPO }), "mnemonic"],
  ])("%s", async (_, kind, content, finding) => {
    const user = await publish(kind, content);
    const guard = await screen.findByTestId("secret-guard");
    expect(guard.dataset.kind).toBe(finding);
    expect(signNostrDraft).not.toHaveBeenCalled();
    expect(fakeEngine.callsTo("nostrPublish")).toHaveLength(0);

    await user.click(screen.getByTestId("secret-guard-cancel"));
    expect(screen.queryByTestId("secret-guard")).toBeNull();
    expect(signNostrDraft).not.toHaveBeenCalled();
    expect(fakeEngine.callsTo("nostrPublish")).toHaveLength(0);

    await user.click(screen.getByTestId("nostr-publish-confirm"));
    await user.click(await screen.findByTestId("secret-guard-send"));
    await waitFor(() => expect(fakeEngine.callsTo("nostrPublish")).toHaveLength(1));
    expect(signNostrDraft).toHaveBeenCalledTimes(1);
  });

  it("a note with no secret is signed and published at once", async () => {
    await publish(1, "good morning, nostr");
    await waitFor(() => expect(fakeEngine.callsTo("nostrPublish")).toHaveLength(1));
    expect(screen.queryByTestId("secret-guard")).toBeNull();
  });
});
