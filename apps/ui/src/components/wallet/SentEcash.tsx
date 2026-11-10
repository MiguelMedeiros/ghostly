import type { WalletAwaitingView } from "@ghostly/browser/shared/types";
import type { WalletNetwork, WalletPlatform } from "../../lib/platform";
import { useI18n } from "../../contexts/I18nContext";
import { removalWords } from "./removalWords";
import { useRun } from "./run";
import { Block, Button, Notice, Row, Section } from "./ui";

/** Take it back on one payment of ecash sent and not taken yet: the engine call the chat's bubble makes. */
export function TakeBack({ wallet, paymentId, busy, run, running, testId }: {
  wallet: WalletPlatform;
  paymentId: string;
  /** Another operation of the same place is under way. */
  busy: boolean;
  run: ReturnType<typeof useRun>["run"];
  running: string | null;
  testId: string;
}) {
  const { t } = useI18n();
  return (
    <Button data-testid={testId} data-payment={paymentId} title={t("payments.bubble.takeBackTitle")} loading={running === paymentId} disabled={busy}
      onClick={() => void run(() => wallet.reclaim(paymentId), paymentId)}>
      {t("payments.bubble.takeBack")}
    </Button>
  );
}

/**
 * Ecash sent in a chat that was deleted since, which the contact has not taken: still the person's, kept by the engine
 * so it can be taken back. Its bubble, where Take it back was, went with the chat, so it is offered here, on the
 * Wallet page of its network. A row goes once it is taken back, or the contact took it.
 */
export function SentEcash({ wallet, network, awaiting }: { wallet: WalletPlatform; network: WalletNetwork; awaiting: readonly WalletAwaitingView[] | undefined }) {
  const { t } = useI18n();
  const { busy, running, error, run } = useRun();
  const items = (awaiting ?? []).filter((a) => a.kind === "sent" && a.chatGone && a.paymentId);
  if (!items.length) return null;
  const words = removalWords(t);
  return (
    <Section title={t("wallet.sentEcash.title")} testId="wallet-sent-ecash">
      {items.map((item) => (
        <Row key={item.paymentId} testId="wallet-sent-ecash-item" label={words.item("sent", words.sats(item.amount, network))} hint={t("payments.bubble.takeBackTitle")}>
          <TakeBack wallet={wallet} paymentId={item.paymentId!} busy={busy} run={run} running={running} testId="wallet-sent-ecash-take-back" />
        </Row>
      ))}
      {error && <Block><Notice problem={error} testId="wallet-sent-ecash-error" /></Block>}
    </Section>
  );
}
