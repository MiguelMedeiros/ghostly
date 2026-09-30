import type { BackupDue } from "@ghostly/browser/shared/backupReminder";
import { useI18n } from "../../contexts/I18nContext";
import { Button, Row } from "./ui";
import { WALLET_NAME } from "./names";

/**
 * The backup reminder (shared/backupReminder): a Mainnet wallet holds real money and no copy of it exists yet. One
 * calm card above the deck, never a dialog: its button leads straight to the copy that wallet needs (its recovery
 * phrase, or for Cashu a profile backup), and "Later" puts it off.
 */
export function BackupReminder({ due, busy, onBackUp, onLater }: { due: BackupDue; busy?: boolean; onBackUp: () => void; onLater: () => void }) {
  const { t } = useI18n();
  return (
    <div data-testid="backup-reminder" data-wallet={due.id} data-backup={due.backup} className="rounded-xl border border-accent/40 bg-accent/5">
      <Row label={<span className="font-medium">{t("wallet.backupReminder.title", { wallet: WALLET_NAME[due.type] })}</span>}
        hint={t("wallet.backupReminder.body")} info={t(`wallet.backupReminder.info.${due.backup}`)}>
        <Button variant="primary" data-testid="backup-reminder-go" onClick={onBackUp}>{t(`wallet.backupReminder.go.${due.backup}`)}</Button>
        <Button data-testid="backup-reminder-later" disabled={busy} onClick={onLater}>{t("wallet.backupReminder.later")}</Button>
      </Row>
    </div>
  );
}
