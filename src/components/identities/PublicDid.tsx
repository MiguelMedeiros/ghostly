import { useState } from "react";
import { QRCodeSVG } from "qrcode.react";
import { engine } from "@ghostly/browser/platform/engine";
import type { EngineState } from "@ghostly/browser/shared/types";
import { Block, Button, Notice, Row, Switch } from "../wallet/ui";
import { useI18n } from "../../contexts/I18nContext";
import { useCopyKey } from "../../hooks/useCopyKey";
import { idCard } from "./idCard";
import { ProviderMark, StatusPill } from "./ProviderMark";

/**
 * The profile's public DID (did:dht, WISP 3xx-did-dht), in the Ghostly card's details: the identifier with
 * Copy and a QR code, whether it is published, and a switch per identity that lists it in the document for
 * everyone to see. Every switch starts off; chats never need any of this.
 */
export function PublicDid({ state }: { state: EngineState }) {
  const { t } = useI18n();
  const did = state.did;
  const { copied, copy } = useCopyKey(did?.id ?? "");
  const [qr, setQr] = useState(false);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  if (!did) return null;

  const now = Date.now() / 1000;
  const listable = state.identityProofs.filter(p => p.publicUri);
  const status = did.error ? t("identities.did.failed", { error: did.error })
    : did.published && did.upToDate ? t("identities.did.published", { time: new Date(did.published.at).toLocaleString() })
    : !state.settings.online ? t("identities.did.offline")
    : did.published ? t("identities.did.updating") : t("identities.did.publishing");
  const list = (id: string, listed: boolean) => {
    setBusy(id); setError("");
    void engine.call("setDidListed", { id, listed }).catch(e => setError(e instanceof Error ? e.message : String(e))).finally(() => setBusy(""));
  };

  return (
    <div data-testid="did-section" className="divide-y divide-border">
      <Row label={<span className="flex flex-wrap items-center gap-2">{t("identities.did.title")}
        <StatusPill ok={!!did.published && did.upToDate && !did.error} testId="did-published">{did.published && did.upToDate && !did.error ? t("identities.did.live") : t("identities.did.notLive")}</StatusPill></span>}
        hint={t("identities.did.hint")} />
      <Block>
        <code className="block break-all select-all bg-surface-alt rounded-lg p-2 text-[11px] text-text-primary" data-testid="did-id">{did.id}</code>
        <div className="flex flex-wrap items-center gap-3">
          <Button data-testid="did-copy" onClick={copy}>{copied ? t("identities.ghostly.copied") : t("identities.did.copy")}</Button>
          <Button data-testid="did-qr-toggle" aria-expanded={qr} onClick={() => setQr(v => !v)}>{qr ? t("identities.did.hideQr") : t("identities.did.showQr")}</Button>
        </div>
        {qr && <div data-testid="did-qr" className="bg-white p-3 rounded-xl w-fit max-w-full [&_svg]:max-w-full [&_svg]:h-auto">
          <QRCodeSVG value={did.id} size={200} marginSize={2} title={t("identities.did.qrTitle")} bgColor="#ffffff" fgColor="#0b0f1a" level="M" />
        </div>}
        <Notice tone={did.error ? "error" : "muted"} testId="did-status">{status}</Notice>
      </Block>
      <Block testId="did-links">
        <p className="text-xs font-medium text-text-secondary">{t("identities.did.listTitle")}</p>
        <Notice tone="warning" testId="did-warning">{t("identities.did.warning")}</Notice>
        {listable.length === 0 ? <p className="text-xs text-text-muted" data-testid="did-none">{t("identities.did.none")}</p>
          : listable.map(p => {
            const card = idCard(p, { now });
            const listed = did.listed.includes(p.id);
            const current = p.expiresAt > now;
            return (
              <div key={p.id} data-testid="did-identity" data-proof-id={p.id} className="flex items-center gap-3">
                <ProviderMark provider={p.provider} subject={card.bound} />
                <div className="flex-1 min-w-0">
                  <p className="text-sm text-text-primary break-words">{card.label} <span className="text-text-muted">{card.short}</span></p>
                  <p className="text-xs text-text-muted break-all">{current ? p.publicUri : t("identities.did.expired")}</p>
                </div>
                <Switch testId="did-list" checked={listed} disabled={!!busy || (!listed && !current)}
                  label={t("identities.did.listOne", { identity: `${card.label} ${card.short}` })} onChange={next => list(p.id, next)} />
              </div>
            );
          })}
        {error && <Notice tone="error" testId="did-error">{error}</Notice>}
      </Block>
    </div>
  );
}
