import { useEffect, useState } from "react";
import type { ContactRequestView } from "@ghostly/browser/shared/types";
import { engine } from "@ghostly/browser/platform/engine";
import { Page } from "../components/layout";
import { Button, Notice } from "../components/wallet/ui";
import { useI18n } from "../contexts/I18nContext";
import { useAppNavigation } from "../hooks/useAppNavigation";
import { adoptEngineChat } from "../lib/contactLinks";
import { useEngineState } from "../lib/engineState";
import { problemLine } from "../lib/problemText";
import { formatAt } from "../lib/time";
import { chatPath } from "../lib/url";

const WHEN: Intl.DateTimeFormatOptions = { dateStyle: "medium", timeStyle: "short" };

/**
 * Requests (WISP 8xx, Contact Links): what people sent through this profile's contact link, apart from the chats.
 * Accept starts the chat (the requester's invite, joined, with its name and first message); Decline says nothing back,
 * and that requester cannot ask again through this link. Opening the page looks for new requests at once.
 */
export function Requests() {
  const { t, language } = useI18n();
  const state = useEngineState();
  const nav = useAppNavigation();
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const link = state?.contactLink;
  const requests = state?.contactRequests ?? [];

  useEffect(() => { void engine.call("contactLinkShown").catch(() => {}); }, []);

  const answer = (request: ContactRequestView, accept: boolean) => {
    setBusy(request.id);
    setError("");
    const call = accept
      ? engine.call("acceptContactRequest", { id: request.id }).then(({ linkId }) => adoptEngineChat(linkId)).then((id) => nav.conversation(chatPath(id)))
      : engine.call("declineContactRequest", { id: request.id });
    void call.catch((e) => setError(problemLine(e, t))).finally(() => setBusy(""));
  };

  return (
    <Page title={t("requests.title")} width="md" testId="requests-page">
      {link?.state === "busy" && <Notice tone="warning" testId="requests-busy">{t("requests.busy")}</Notice>}
      {!!link?.missed && <Notice tone="muted" testId="requests-missed">{t("requests.missed", { count: link.missed })}</Notice>}
      {error && <Notice tone="error" testId="requests-error">{error}</Notice>}
      {!requests.length && <p data-testid="requests-empty" className="text-sm text-text-muted">{link ? t("requests.empty") : t("requests.noLink")}</p>}
      {requests.length > 0 && (
        <>
          <p className="text-xs text-text-muted">{t("requests.unverified")}</p>
          <ul className="space-y-3" data-testid="requests-list">
            {requests.map((request) => (
              <li key={request.id} data-testid="request" className="rounded-xl border border-border bg-surface p-4 space-y-2">
                <div className="flex flex-wrap items-baseline justify-between gap-x-3">
                  <bdi className="font-medium text-text-primary break-words" data-testid="request-name">{request.name}</bdi>
                  <span className="text-xs text-text-muted">{formatAt(request.receivedAt, WHEN, language)}</span>
                </div>
                <p dir="auto" className="whitespace-pre-wrap break-words text-sm text-text-secondary" data-testid="request-text">{request.text}</p>
                <div className="flex flex-wrap gap-2 pt-1">
                  <Button variant="primary" data-testid="request-accept" loading={busy === request.id} disabled={!!busy} onClick={() => answer(request, true)}>{t("requests.accept")}</Button>
                  <Button variant="danger" data-testid="request-decline" disabled={!!busy} onClick={() => answer(request, false)}>{t("requests.decline")}</Button>
                </div>
              </li>
            ))}
          </ul>
        </>
      )}
    </Page>
  );
}
