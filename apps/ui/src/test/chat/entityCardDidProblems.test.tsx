import { screen, within } from "@testing-library/react";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { DidError } from "@ghostly/core";
import { loadIdentityProviders } from "@ghostly/browser/proofs/load";
import { MessageBubble } from "../../components/MessageBubble";
import { providerOf } from "../../lib/identities";
import { renderApp } from "../render";

// covers: chat.cards.identity, app.i18n

/*
 * A DID card in a message says what it resolved in the app's language, but a lookup that found no usable document
 * said why in English in every language: "No DID document at https://…/did.json" for a did:web whose server has none,
 * "… is not JSON", and "This DID lists no Ed25519, secp256k1 or P-256 key …" for a document with no key that can sign.
 * The Add dialog's preview said them the same way.
 */

const DID = "did:web:example.org";
const URL_ = "https://example.org/.well-known/did.json";

describe("a DID card whose lookup found no usable document says why in the app's language", () => {
  // Nothing leaves this machine: the lookup fails as the resolver throws it, before any fetch.
  let fetch: MockInstance<typeof globalThis.fetch>;
  beforeEach(() => { fetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(new TypeError("offline in tests")); });
  afterEach(() => fetch.mockRestore());
  // A plain function, set once: the card's translated provider keeps the preview it was first made with, and the
  // config restores spies after each test.
  let failure: Error = new Error("unset");
  let real: unknown;
  const failWith = (e: Error) => {
    failure = e;
    const subject = providerOf("did")!.subject as { preview?: unknown };
    if (real === undefined) { real = subject.preview; subject.preview = async () => { throw failure; }; }
  };
  afterAll(() => { if (real !== undefined) (providerOf("did")!.subject as { preview?: unknown }).preview = real; });

  it.each([
    ["no did.json", `No DID document at ${URL_}`],
    ["a did.json that is not JSON", `${URL_} is not JSON`],
    ["a document with no key that can sign", "This DID lists no Ed25519, secp256k1 or P-256 key for authentication or assertionMethod, so it cannot sign"],
  ])("%s, in Arabic", async (_case, english) => {
    await loadIdentityProviders();
    failWith(new DidError(english));
    const { user } = renderApp(<MessageBubble message={{ id: "m1", text: DID, sender: "me", timestamp: 1_700_000_000_000 }} peerNick="Alice" peerPubKey="peer" />, { language: "ar" });
    const card = screen.getByTestId("entity-identity");
    await user.click(within(card).getByTestId("entity-identity-resolve"));
    const error = await within(card).findByTestId("entity-identity-error");
    expect(error.textContent).not.toMatch(/No DID document|is not JSON|lists no|cannot sign/);
    // The address stays, as a value.
    if (english.includes(URL_)) expect(error).toHaveTextContent(URL_);
    expect(fetch).not.toHaveBeenCalled();
  });
});
