import { useEffect, useState } from "react";
import { Page, PageAction } from "../components/layout";
import { useI18n } from "../contexts/I18nContext";
import { IdentityProofsSection } from "../components/identities/IdentityProofsSection";
import { ContactIdentitiesSection } from "../components/identities/ContactIdentitiesSection";
import { NostrSection } from "../components/nostr/NostrSection";
import { AddIdentityDialog } from "../components/identities/AddIdentityDialog";
import { addableProviders, identityAttention, markIdentityNewsSeen, useEngineState } from "../lib/identities";

/**
 * Identities, a page beside the chat list: this profile's proofs of other identities (add, status, remove),
 * what contacts shared, and the Nostr layer those proofs open. Sharing stays per chat, in each chat's
 * Identities. New, in the header, adds one (the provider picker), when this device can add any.
 */
export function Identities() {
  const { t } = useI18n();
  const state = useEngineState();
  const [adding, setAdding] = useState(false);
  const canAdd = addableProviders().length > 0;
  // The Nostr layer is shown once it has anything to show: a Nostr key of this profile, or a contact's.
  const showNostr = !!state && (state.nostr.own.length > 0 || state.links.some(l => l.nostr?.length));
  // News (a contact's proof revoked, one of yours refused) is seen once it is on this page.
  useEffect(() => { if (state) markIdentityNewsSeen(identityAttention(state)); }, [state]);
  return (
    <Page title={t("tabs.identities")} width="md" testId="identities-page" trailing={state && canAdd && (
      <PageAction label={t("sidebar.new")} title={t("identities.ghostly.addOne")} testId="identities-new" onClick={() => setAdding(true)} />
    )}>
      <p className="text-sm text-text-secondary">Optional proofs that you also hold another identity (a Nostr key, a domain, an account). You choose, one chat at a time, who sees them.</p>
      <IdentityProofsSection onAdd={() => setAdding(true)} />
      <ContactIdentitiesSection />
      {showNostr && <NostrSection />}
      {adding && <AddIdentityDialog onClose={() => setAdding(false)} />}
    </Page>
  );
}
