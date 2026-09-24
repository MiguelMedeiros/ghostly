import { useEffect } from "react";
import { Page } from "../components/layout";
import { useI18n } from "../contexts/I18nContext";
import { IdentityProofsSection } from "../components/identities/IdentityProofsSection";
import { ContactIdentitiesSection } from "../components/identities/ContactIdentitiesSection";
import { NostrSection } from "../components/nostr/NostrSection";
import { identityAttention, markIdentityNewsSeen, useEngineState } from "../lib/identities";

/**
 * Identities, a page beside the chat list: this profile's proofs of other identities (add, status, remove),
 * what contacts shared, and the Nostr layer those proofs open. Sharing stays per chat, in each chat's
 * Identities.
 */
export function Identities() {
  const { t } = useI18n();
  const state = useEngineState();
  // The Nostr layer is shown once it has anything to show: a Nostr key of this profile, or a contact's.
  const showNostr = !!state && (state.nostr.own.length > 0 || state.links.some(l => l.nostr?.length));
  // News (a contact's proof revoked, one of yours refused) is seen once it is on this page.
  useEffect(() => { if (state) markIdentityNewsSeen(identityAttention(state)); }, [state]);
  return (
    <Page title={t("tabs.identities")} width="md" testId="identities-page">
      <p className="text-sm text-text-secondary">Optional proofs that you also hold another identity (a Nostr key, a domain, an account). You choose, one chat at a time, who sees them.</p>
      <IdentityProofsSection />
      <ContactIdentitiesSection />
      {showNostr && <NostrSection />}
    </Page>
  );
}
