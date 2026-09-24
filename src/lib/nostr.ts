import { extensionSigner, withNostrSigner } from "@ghostly/browser/proofs/nostr";
import type { NostrDraft } from "@ghostly/browser/nostr/types";
import { identityPlatform } from "./identities";

/**
 * The Nostr social layer, UI side: signing what the engine drafted with the person's own signer. The
 * NIP-07 extension is only ever the page's own `window.nostr` (web and desktop pages, never assumed
 * inside the extension); NIP-46 takes a bunker link each time, and the ephemeral client key is dropped
 * afterwards. No private key is ever entered in Ghostly.
 */
export type NostrSignerChoice = "nip07" | "nip46";

export function nostrSignerChoices(): { id: NostrSignerChoice; label: string }[] {
  const choices: { id: NostrSignerChoice; label: string }[] = [];
  if (identityPlatform() !== "extension" && extensionSigner()) choices.push({ id: "nip07", label: "Browser extension (NIP-07)" });
  choices.push({ id: "nip46", label: "Remote signer (NIP-46)" });
  return choices;
}

/** What a bunker is asked for: only the kind being published. */
const PERMISSION: Record<number, string> = { 0: "sign_event:0", 1: "sign_event:1", 3: "sign_event:3" };

/** Signs the draft's template with the signer, after checking the signer holds the draft's key. */
export async function signNostrDraft(draft: NostrDraft, options: { signer: NostrSignerChoice; bunker?: string; signal: AbortSignal; onAuth(url: string): void; onProgress(text: string): void }): Promise<unknown> {
  return withNostrSigner({ bunker: options.signer === "nip46" ? options.bunker : undefined, signal: options.signal, onAuth: options.onAuth, permissions: PERMISSION[draft.template.kind] ?? `sign_event:${draft.template.kind}`, appName: "Ghostly — publish on Nostr" }, async signer => {
    options.onProgress("Asking your signer which key it holds…");
    const key = (await signer.getPublicKey()).trim().toLowerCase();
    if (key !== draft.subject) throw new Error("Your signer holds a different key than this identity. Nothing was published.");
    options.onProgress("Approve the event in your signer…");
    return signer.signEvent(draft.template);
  });
}

export { ago } from "./time";
