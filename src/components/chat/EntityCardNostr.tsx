import { useState } from "react";
import { engine } from "@ghostly/browser/platform/engine";
import type { NostrPointer } from "@ghostly/browser/nostr/social";
import { shortNpub } from "@ghostly/browser/nostr/social";
import type { NostrLookupResult } from "@ghostly/browser/nostr/types";
import { useEngineState } from "../../lib/identities";
import { ago } from "../../lib/nostr";
import { ProviderMark } from "../identities/ProviderMark";
import { EntityCardFrame, cardQuiet } from "./EntityCardFrame";

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));
const shortCode = (code: string) => (code.length > 24 ? `${code.slice(0, 14)}…${code.slice(-6)}` : code);
const keyOf = (p: NostrPointer) => (p.type === "profile" ? `p:${p.pubkey}` : `e:${p.id}`);

/** What was loaded on this device while the app runs, so a card scrolled away and back shows it again. Never stored. */
const loaded = new Map<string, NostrLookupResult>();
/** "relay.damus.io, nos.lol": relays as people read them. */
const relayNames = (relays: readonly string[]) => relays.map(r => r.replace(/^wss?:\/\//, "").replace(/\/+$/, "")).join(", ");

/**
 * An `npub`, `nprofile`, `note` or `nevent` in a message. Nothing is fetched until a tap: then the engine asks the
 * relays in the person's own profile (named on the card before the tap), never the relays a code names, which could
 * be anyone's. What comes back is what the key published about itself, shown as plain text.
 */
export function NostrEntityCard({ code, pointer }: { code: string; pointer: NostrPointer }) {
  const state = useEngineState();
  const relays = state?.nostr.settings.relays ?? [];
  const [result, setResult] = useState(() => loaded.get(keyOf(pointer)));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const profile = pointer.type === "profile";

  const load = async () => {
    setError(""); setBusy(true);
    try {
      const found = await engine.call("nostrLookup", pointer.type === "profile"
        ? { type: "profile", pubkey: pointer.pubkey }
        : { type: "note", id: pointer.id, ...(pointer.author ? { author: pointer.author } : {}) });
      loaded.set(keyOf(pointer), found);
      setResult(found);
    } catch (e) { setError(message(e)); } finally { setBusy(false); }
  };

  const p = result?.profile, note = result?.note;
  const title = profile
    ? p?.name ?? shortNpub(pointer.pubkey)
    : note ? `Note by ${shortNpub(note.author)}` : "A note on Nostr";
  const subtitle = profile ? (p?.handle ? `@${p.handle} · ${shortNpub(pointer.pubkey)}` : p?.name ? shortNpub(pointer.pubkey) : undefined) : undefined;

  return (
    <EntityCardFrame testId="entity-nostr" data={{ "data-type": pointer.type, "data-loaded": result ? "true" : undefined }}
      label={profile ? "Nostr profile" : "Nostr note"} mark={<ProviderMark provider="nostr" />}
      title={<span data-testid="entity-nostr-title">{title}</span>}
      subtitle={subtitle ?? <span className="font-mono" title={code}>{shortCode(code)}</span>}>
      {result && !result.found && <p className="m-0" data-testid="entity-nostr-none">{profile ? "No profile published under this key on your relays." : "Your relays do not have this note."}</p>}
      {p && <>
        {p.avatar && <img src={p.avatar} alt="" data-testid="entity-nostr-avatar" className="h-10 w-10 rounded-full object-cover" />}
        {p.about && <p data-testid="entity-nostr-about" className="m-0 line-clamp-4 whitespace-pre-wrap break-words text-text-primary">{p.about}</p>}
        {p.nip05 && <p className="m-0 break-all">{p.nip05} <span className="text-text-primary/65">(NIP-05, as they wrote it, not checked)</span></p>}
      </>}
      {note && (note.muted
        ? <p className="m-0" data-testid="entity-nostr-muted">Hidden by your Nostr mute list.</p>
        : <p data-testid="entity-nostr-note" className="m-0 line-clamp-6 whitespace-pre-wrap break-words text-text-primary">{note.content}</p>)}
      {note && <p className="m-0 text-text-primary/65">{ago(note.createdAt)}{note.reply ? " · a reply" : ""}</p>}
      {result
        ? <p className="m-0 text-[11px] text-text-primary/65" data-testid="entity-nostr-source">From {relayNames(result.relays)} {ago(result.fetchedAt)}. Self-described by the key that signed it.</p>
        : <p className="m-0 text-[11px] text-text-primary/65" data-testid="entity-nostr-where">
          Loading asks your relays ({relayNames(relays)}), which learn your IP address and this {profile ? "key" : "note"}.
          {pointer.relays.length > 0 && " The relays this code names are not asked."}
        </p>}
      <button type="button" data-testid="entity-nostr-load" disabled={busy} className={cardQuiet} onClick={() => void load()}>
        {busy ? "Loading…" : result ? "Refresh" : profile ? "Load profile" : "Load note"}
      </button>
      {error && <p role="alert" data-testid="entity-nostr-error" className="m-0 text-danger-ink">{error}</p>}
    </EntityCardFrame>
  );
}
