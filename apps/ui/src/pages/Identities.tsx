import { useEffect, useState } from "react";
import { Page, PageAction } from "../components/layout";
import { useI18n } from "../contexts/I18nContext";
import { IdentityProofsSection } from "../components/identities/IdentityProofsSection";
import { ContactIdentitiesSection } from "../components/identities/ContactIdentitiesSection";
import { NostrSection } from "../components/nostr/NostrSection";
import { AddIdentityDialog } from "../components/identities/AddIdentityDialog";
import { addableProviders, identityAttention, markIdentityNewsSeen, useEngineValue } from "../lib/identities";
import { SIGN_IN_INTERRUPTED_EVENT, takeSignInInterrupted } from "../lib/signInInterrupted";
import { Button, Notice } from "../components/wallet/ui";

/**
 * Identities, a page beside the chat list: this profile's proofs of other identities (add, status, remove),
 * what contacts shared, and the Nostr layer those proofs open. Sharing stays per chat, in each chat's
 * Identities. New, in the header, adds one (the provider picker), when this device can add any.
 */
export function Identities() {
  const { t } = useI18n();
  // Only what the page itself shows of the engine's state (its sections read their own parts): it stays open, and the
  // whole state drew it, and every section in it, again on every state.
  const state = useEngineValue(s => s && {
    // The Nostr layer is shown once it has anything to show: a Nostr key of this profile, or a contact's.
    showNostr: s.nostr.own.length > 0 || s.links.some(l => l.nostr?.length),
    attention: identityAttention(s),
  });
  const [adding, setAdding] = useState(false);
  // A sign-in Android cut off (its process ended while the provider's page was in the browser): said here, once.
  const [interrupted, setInterrupted] = useState(false);
  useEffect(() => {
    const heard = () => { if (takeSignInInterrupted()) setInterrupted(true); };
    heard();
    window.addEventListener(SIGN_IN_INTERRUPTED_EVENT, heard);
    return () => window.removeEventListener(SIGN_IN_INTERRUPTED_EVENT, heard);
  }, []);
  const add = () => { setInterrupted(false); setAdding(true); };
  const canAdd = addableProviders().length > 0;
  const showNostr = !!state?.showNostr;
  // News (a contact's proof revoked, one of yours refused) is seen once it is on this page.
  useEffect(() => { if (state) markIdentityNewsSeen(state.attention); }, [state]);
  return (
    <Page title={t("tabs.identities")} width="md" testId="identities-page" trailing={!!state && canAdd && (
      <PageAction label={t("sidebar.new")} title={t("identities.ghostly.addOne")} testId="identities-new" onClick={add} />
    )}>
      {interrupted && (
        <div className="space-y-2" data-testid="sign-in-interrupted">
          <Notice tone="error" title={t("identities.add.interrupted")} />
          {canAdd && <Button variant="primary" onClick={add}>{t("identities.add.tryAgain")}</Button>}
        </div>
      )}
      <p className="text-sm text-text-secondary">{t("identities.page.intro")}</p>
      <IdentityProofsSection onAdd={add} />
      <ContactIdentitiesSection />
      {showNostr && <NostrSection />}
      {adding && <AddIdentityDialog onClose={() => setAdding(false)} />}
    </Page>
  );
}
