import { useEffect } from "react";
import type { ReceivedIdentityView } from "@ghostly/browser/shared/types";
import { chatsByPeer } from "../../lib/identities";
import { Select } from "../ui/Select";
import { BadgeMark } from "./BadgeMark";
import { contactBadges } from "./contactBadges";
import { contactFace, faceCandidates, setFaceChoice, suggestedFace, useFaceChoice, type ContactFace } from "./contactFace";
import { loadShownProfiles } from "./markTip";

const GHOSTLY_VALUE = "ghostly";
const valueOf = (f: Pick<ContactFace, "provider" | "subject">) => `${f.provider}:${f.subject}`;

/** A candidate's picture, or its provider's mark. */
const faceMark = (f: ContactFace, size: number) => <BadgeMark provider={f.provider} subject={f.subject} state="verified" photo={f.photo} size={size} />;

/**
 * "Show as": which of the contact's verified identities with a public profile gives them their name and photo in the
 * chat list, the chat's header and group mentions (contactFace.ts), or none (their Ghostly name). Only on this device.
 * A contact with exactly one such identity, no nickname and nothing chosen yet gets a one-tap offer; nothing is
 * applied by itself. A nickname given in the chat keeps the name, and the photo still comes from the identity.
 */
export function ContactFacePicker({ peerKey, received }: { peerKey: string; received: ReceivedIdentityView[] }) {
  const choice = useFaceChoice(peerKey);
  const candidates = faceCandidates(received);
  const face = contactFace(received, choice);
  const nickname = chatsByPeer().get(peerKey)?.label?.trim() || undefined;
  const offer = suggestedFace(received, choice, nickname);
  // The profiles the choice is between are read like cards on screen (the engine caches them).
  const good = contactBadges(received, { good: true });
  const goodKey = good.map(b => `${b.provider}:${b.subject}`).join(",");
  useEffect(() => { loadShownProfiles(good); }, [goodKey]); // eslint-disable-line react-hooks/exhaustive-deps
  // A choice whose proof or profile is gone shows as Ghostly, with a line saying why.
  const lapsed = !!choice && choice !== "none" && !face;
  if (!candidates.length && !lapsed) return null;
  const options = [
    { value: GHOSTLY_VALUE, label: "Ghostly (none)", description: "Their Ghostly name" },
    ...candidates.map(c => ({ value: valueOf(c), label: c.name ?? c.providerName, description: `${c.providerName} profile`, icon: faceMark(c, 20) })),
  ];
  return (
    <section className="contact-panel-section" data-testid="contact-face" aria-label="Show as">
      <h3 className="contact-panel-heading">Show as</h3>
      {offer && (
        <button type="button" className="contact-face-offer" data-testid="contact-face-suggest" onClick={() => setFaceChoice(peerKey, { provider: offer.provider, subject: offer.subject })}>
          {faceMark(offer, 28)}
          <span className="min-w-0">
            <span className="contact-face-offer-title">Use {offer.providerName} name & photo</span>
            {offer.name && <bdi className="contact-face-offer-name">{offer.name}</bdi>}
          </span>
        </button>
      )}
      <Select<string> aria-label="Show this contact as" data-testid="contact-face-select" value={face ? valueOf(face) : GHOSTLY_VALUE} options={options}
        onChange={value => {
          const picked = candidates.find(c => valueOf(c) === value);
          setFaceChoice(peerKey, picked ? { provider: picked.provider, subject: picked.subject } : "none");
        }} />
      <p className="contact-panel-note" data-testid="contact-face-hint">
        {lapsed ? "That profile's proof no longer holds, so their Ghostly name is back."
          : nickname && face ? `Your nickname “${nickname}” stays; the photo is theirs.`
            : "Name and photo in your chat list. Only on this device."}
      </p>
    </section>
  );
}
