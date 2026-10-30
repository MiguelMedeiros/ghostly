import type { ContactAskView } from "@ghostly/browser/shared/types";
import { useI18n, type TranslationKey } from "../../contexts/I18nContext";
import { useEngineState } from "../../lib/engineState";

const SAID: Record<ContactAskView["state"], TranslationKey> = {
  sending: "requests.askedSending",
  knocking: "requests.askedSending",
  seen: "requests.askedSeen",
  off: "requests.askedOff",
  ended: "requests.askedEnded",
};

/**
 * A chat made for a request sent through someone's contact link (WISP 8xx), while nobody answered it: where the request
 * is. It arrived (`seen`) says nothing about an answer: the owner accepts, or nothing is said back.
 */
export function AskedNotice({ linkId, answered }: { linkId: string | undefined; answered: boolean }) {
  const { t } = useI18n();
  const ask = useEngineState()?.contactAsks?.find((a) => a.chatId === linkId);
  if (!ask || answered) return null;
  return (
    <p data-testid="asked-notice" data-state={ask.state} className="mx-auto mb-3 max-w-md px-4 text-center text-xs text-text-muted">
      {t(SAID[ask.state])}
    </p>
  );
}
