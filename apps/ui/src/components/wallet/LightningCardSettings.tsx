import { useState } from "react";
import type { WalletPlatform, WalletState } from "../../lib/platform";
import { InputGroup } from "../layout";
import { useRun } from "./run";
import { Block, Button, Notice, Row, Section, Switch, input } from "./ui";
import { useI18n } from "../../contexts/I18nContext";

/**
 * One Lightning card of several on its network: whether it is the default for receiving (chat requests and Receive
 * use it unless another card is picked), and its name. A network's only card is its Lightning: nothing to set here.
 * The control pressed keeps the keys while it works and after it (busy, unavailable, aria-disabled; never disabled,
 * which drops a keyboard's focus to the page in Chromium); the other waits, disabled.
 */
export function LightningCardSettings({ wallet, state }: { wallet: WalletPlatform; state: WalletState }) {
  const { t } = useI18n();
  const ln = state.lightning;
  const { busy, running, error, run } = useRun();
  const [name, setName] = useState(ln?.name ?? "");
  if (!ln?.card || (state.lightnings?.length ?? 0) < 2) return null;
  const receive = !!ln.receive, changed = name.trim() !== "" && name.trim() !== ln.name;
  return (
    <Section title={t("wallet.lightning.card.title")} testId="lightning-card">
      <Row label={t("wallet.lightning.card.default")} hint={t("wallet.lightning.card.defaultHint")}>
        <Switch checked={receive} disabled={running === "rename"} busy={running === "receive"} unavailable={receive} label={t("wallet.lightning.card.default")} testId="lightning-card-default" onChange={() => void run(() => wallet.lightningSetReceive(), "receive")} />
      </Row>
      <Block>
        <InputGroup as="form" onSubmit={(e) => { e.preventDefault(); if (!busy && changed) void run(() => wallet.lightningRename(name), "rename"); }}>
          <input aria-label={t("wallet.lightning.card.name")} data-testid="lightning-card-name" className={input} maxLength={32} value={name} onChange={(e) => setName(e.target.value)} />
          <Button type="submit" data-testid="lightning-card-rename" disabled={running === "receive"} loading={running === "rename"} aria-disabled={!changed || undefined} className={changed ? "" : "opacity-40 cursor-not-allowed"}>{t("wallet.lightning.card.rename")}</Button>
        </InputGroup>
        {error && <Notice problem={error} testId="lightning-card-error" />}
      </Block>
    </Section>
  );
}
