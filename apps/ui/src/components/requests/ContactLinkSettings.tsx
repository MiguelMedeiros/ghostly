import { useEffect, useState } from "react";
import { inviteQrSegments } from "@ghostly/core";
import { engine } from "@ghostly/browser/platform/engine";
import { Block, Row } from "../layout";
import { Button, Notice } from "../wallet/ui";
import { QRCodeDisplay } from "../QRCode";
import { useI18n } from "../../contexts/I18nContext";
import { useEngineState } from "../../lib/engineState";
import { problemLine } from "../../lib/problemText";

/**
 * The profile's contact link (WISP 8xx), in Settings → Profile: one link to post on a site or a card that names
 * nobody. Make it, copy it or show its QR, make a new one (the old one stops) or turn it off. Showing it tells the
 * engine to look for requests often for a while: people open a link in the minutes after it is shared.
 */
export function ContactLinkSettings() {
  const { t } = useI18n();
  const link = useEngineState()?.contactLink;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [confirmOff, setConfirmOff] = useState(false);
  const code = link?.code;

  useEffect(() => { if (code) void engine.call("contactLinkShown").catch(() => {}); }, [code]);

  const act = (work: () => Promise<unknown>) => {
    setBusy(true); setError("");
    void work().catch((e) => setError(problemLine(e, t))).finally(() => { setBusy(false); setConfirmOff(false); });
  };

  return (
    <div data-testid="contact-link-settings" className="divide-y divide-border">
      <Row label={t("requests.linkTitle")} hint={t("requests.linkHint")} />
      <Block>
        {!link && <Button variant="primary" data-testid="contact-link-create" loading={busy} onClick={() => act(() => engine.call("createContactLink"))}>{t("requests.linkMake")}</Button>}
        {link && (
          <>
            <code className="block break-all select-all bg-surface-alt rounded-lg p-2 text-[11px] text-text-primary" data-testid="contact-link-url">{link.link}</code>
            <QRCodeDisplay value={link.link} qr={inviteQrSegments(link.code)} copyLabel={t("requests.linkCopy")} />
            <p className="text-xs text-text-muted">{t("requests.linkPrivate")}</p>
            <div className="flex flex-wrap gap-2">
              <Button data-testid="contact-link-new" disabled={busy} onClick={() => act(() => engine.call("createContactLink"))}>{t("requests.linkNew")}</Button>
              {!confirmOff && <Button variant="danger" data-testid="contact-link-off" disabled={busy} onClick={() => setConfirmOff(true)}>{t("requests.linkOff")}</Button>}
              {confirmOff && <Button variant="danger" data-testid="contact-link-off-confirm" loading={busy} onClick={() => act(() => engine.call("turnOffContactLink"))}>{t("requests.linkOffConfirm")}</Button>}
            </div>
            {link.error && <Notice tone="error" testId="contact-link-publish-error">{t("requests.linkNotPublished")}</Notice>}
          </>
        )}
        {error && <Notice tone="error" testId="contact-link-error">{error}</Notice>}
      </Block>
    </div>
  );
}
