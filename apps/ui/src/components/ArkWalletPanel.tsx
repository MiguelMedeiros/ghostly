import { useState } from "react";
import { paymentUri, type PaymentReview as Review } from "@ghostly/core";
import type { WalletPlatform, WalletState } from "../lib/platform";
import { PaymentReview } from "./PaymentReview";
import { paymentStateLabel } from "./paymentWords";
import { BackupRows } from "./wallet/BackupRows";
import { Actions, Address, Amount, Block, Button, Notice, Row, Section, Segmented, input, type Action } from "./wallet/ui";
import { useRun } from "./wallet/run";
import { InputGroup, Truncate } from "./layout";
import { useI18n } from "../contexts/I18nContext";
import { satsIn } from "./NetworkTag";
import { formatAmount } from "../lib/amount";

type Network = "bitcoin" | "mutinynet" | "signet" | "regtest";
/** Where each network's wallet connects unless someone types another provider. */
const NETWORKS: Record<Network, { label: string; provider: string; explorer: string }> = {
 bitcoin: { label: "Bitcoin", provider: "https://arkade.computer", explorer: "https://mempool.space/api" },
 mutinynet: { label: "Mutinynet", provider: "https://mutinynet.arkade.sh", explorer: "https://mutinynet.com/api" },
 signet: { label: "Signet", provider: "https://signet.arkade.sh", explorer: "https://mempool.space/signet/api" },
 regtest: { label: "Regtest", provider: "http://127.0.0.1:47010", explorer: "http://127.0.0.1:47002" },
};
/** Ark payments cost nothing today; the cap only stops a surprise, and the review shows the real fee. */
const feeCap = (amount: number) => Math.max(100, Math.ceil(amount / 100));

export function ArkWalletPanel({ wallet, state, backupNow = false }: { wallet: WalletPlatform; state: WalletState; backupNow?: boolean }) {
 const ark = state.ark;
 const { t } = useI18n();
 const { busy, error, run } = useRun();
 const [action, setAction] = useState<Action>("receive");
 const [via, setVia] = useState<"ark" | "onchain">("ark");
 const [address, setAddress] = useState(""), [amount, setAmount] = useState(""), [review, setReview] = useState<Review | null>(null);
 const [password, setPassword] = useState("");
 const [custom, setCustom] = useState(false), [provider, setProvider] = useState(""), [explorer, setExplorer] = useState("");
 const network = (ark?.network ?? "bitcoin") as Network;
 const test = network !== "bitcoin";
 const unit = satsIn(t, test ? "testnet" : "mainnet");
 const ready = !!ark?.configured && !ark.locked;
 const intents = (state.intents ?? []).filter(i => i.method === "arkade");
 const stuck = !!ark?.configured && !!ark.automatic && !ready;
 const canReplace = intents.length === 0 && (stuck || (ready && ark.balance === 0));
 const use = (next: Network, params: { provider?: string; explorer?: string; mnemonic?: string } = {}) => wallet.arkCreate({ network: next, provider: params.provider ?? NETWORKS[next].provider, explorer: params.explorer ?? NETWORKS[next].explorer, mnemonic: params.mnemonic });

 return <div className="space-y-6" data-testid="ark-wallet">
  {!ark?.configured || (ark.locked && ark.automatic) ? <div className="bg-surface rounded-xl p-6 text-center space-y-2" data-testid="ark-connecting"><p className="text-text-primary">{t("wallet.panel.connecting", { wallet: "Ark" })}</p><Notice>{ark?.error ?? t("wallet.panel.firstTime")}</Notice></div>
  : !ready ? <Section title={t("wallet.panel.unlock.title")}><Row label={t("wallet.panel.unlock.withPassword")} /><Block><InputGroup><input aria-label={t("wallet.panel.unlock.password", { wallet: "Ark" })} type="password" autoComplete="current-password" className={input} value={password} onChange={e => setPassword(e.target.value)} /><Button variant="primary" disabled={busy} onClick={() => void run(async () => { await wallet.arkUnlock(password); setPassword(""); })}>{t("wallet.panel.unlock.button", { wallet: "Ark" })}</Button></InputGroup></Block></Section>
  : <div className="space-y-4">
   <p className="text-text-primary" data-testid="ark-balance"><span className="text-4xl font-semibold tabular-nums">{formatAmount(ark.balance, t.language)}</span><span className="text-text-muted text-sm ms-2">{unit}</span>{test && <span className="block text-xs text-yellow-500 mt-1">{t("wallet.panel.testCoins", { network: NETWORKS[network].label })}</span>}</p>
   <Actions value={action} onChange={setAction} />
   {action === "receive" && <div className="bg-surface rounded-xl p-4 space-y-4 animate-fade-in">
    <Segmented label={t("wallet.panel.receiveOn")} value={via} onChange={setVia} options={[{ value: "ark", label: t("wallet.panel.instant", { wallet: "Ark" }) }, { value: "onchain", label: t("wallet.panel.onchain") }]} />
    {via === "ark" ? <Address value={ark.address} uri={ark.address ? paymentUri({ kind: "ark", address: ark.address }) : undefined} testId="ark-address" note={t("wallet.ark.arrives")} />
     : <Address value={ark.boardingAddress} qr={ark.boardingAddress ? `bitcoin:${ark.boardingAddress}` : undefined} testId="ark-boarding-address" note={network === "regtest" ? t("wallet.ark.boardingRegtest") : t("wallet.ark.boarding")} />}
   </div>}
   {/* Outputs whose batch expired before renewal are still this wallet's. Until the server sweeps that batch they
       can be neither spent nor recovered (a recovery then fails, and the server bans the coins for a while): say
       so plainly, and offer Recover only once every expired coin is swept. */}
   {!!ark.sweeping && <div className="rounded-xl bg-yellow-500/10" data-testid="ark-sweeping">
    <Row label={<span className="text-xs text-yellow-500">{t("wallet.ark.sweeping", { amount: formatAmount(ark.sweeping, t.language), unit })}</span>} info={t("wallet.ark.sweepingInfo")} />
   </div>}
   {/* Swept, but too few together for the one coin a recovery makes: they wait for more to expire. */}
   {!!ark.small && <div className="rounded-xl bg-yellow-500/10" data-testid="ark-small">
    <Row label={<span className="text-xs text-yellow-500">{t("wallet.ark.small", { amount: formatAmount(ark.small, t.language), unit })}</span>} info={t("wallet.ark.smallInfo")} />
   </div>}
   {!!ark.recoverable && !ark.sweeping && <div className="flex flex-wrap items-center gap-3 rounded-xl bg-yellow-500/10 px-3 py-2" data-testid="ark-recoverable">
    <p className="flex-[1_1_12rem] min-w-0 text-xs text-yellow-500">{t("wallet.ark.expired", { amount: formatAmount(ark.recoverable, t.language), unit })}</p>
    <Button data-testid="ark-recover" disabled={busy} onClick={() => void run(() => wallet.arkRecover())}>{busy ? t("wallet.ark.recovering") : t("wallet.ark.recover")}</Button>
   </div>}
   {!!ark.incoming && <Notice tone="warning" testId="ark-incoming">{t("wallet.ark.incoming", { amount: formatAmount(ark.incoming, t.language), unit })}</Notice>}
   {action === "send" && <div className="bg-surface rounded-xl p-4 space-y-3 animate-fade-in">
    <input aria-label={t("wallet.panel.recipient", { wallet: "Ark" })} placeholder={t("wallet.panel.recipientPlaceholder", { wallet: "Ark" })} spellCheck={false} className={`${input} font-mono text-xs`} value={address} onChange={e => setAddress(e.target.value.trim())} />
    <Amount value={amount} onChange={setAmount} unit={unit} />
    <Button variant="primary" className="w-full" disabled={busy || !!review || !ark.balance || !address || !Number(amount)} onClick={() => void run(async () => { setReview(await wallet.preparePayment({ target: { method: "arkade", network: ark.network!, provider: ark.provider!, asset: "BTC", unit: "sat", address, expiresAt: Date.now() + 5 * 60 * 1000 }, amount: Number(amount), feeCap: feeCap(Number(amount)), payee: address })); })}>{ark.balance ? t("wallet.panel.review") : t("wallet.panel.noBalance")}</Button>
    <Notice>{t("wallet.ark.approve")}</Notice>
   </div>}
   {review && <PaymentReview key={review.id} review={review} wallet={wallet} onClose={() => setReview(null)} />}
   {intents.filter(i => i.id !== review?.id).map(i => <Button key={i.id} className="block w-full text-start" onClick={() => setReview(i)}>{t("wallet.panel.intent", { amount: formatAmount(i.amount, t.language), unit, state: paymentStateLabel(t, i.state) })}</Button>)}
  </div>}
  {error && <Notice tone="error">{error}</Notice>}
  {ark?.error && ready && <Notice tone="warning">{ark.error}</Notice>}

  {(ready || stuck) && <Section title={t("wallet.panel.settings")}>
   {/* A Mainnet wallet is Bitcoin only; a Testnet wallet may move between the test networks while empty. */}
   {state.mode === "testnet" && <Row label={t("wallet.panel.network")} hint={stuck ? t("wallet.panel.networkStuck") : canReplace ? t("wallet.panel.testNetworks") : t("wallet.panel.onlyEmpty")}>
    <Segmented label={t("wallet.ark.networkLabel")} value={network} disabled={busy || !canReplace} options={(Object.keys(NETWORKS) as Network[]).filter(value => value !== "bitcoin").map(value => ({ value, label: NETWORKS[value].label }))} onChange={next => void run(() => use(next))} />
   </Row>}
   {ready && <><Row label={t("wallet.ark.provider")} hint={ark.provider && <Truncate className="font-mono">{ark.provider}</Truncate>}><Button disabled={!canReplace} onClick={() => { setCustom(!custom); setProvider(ark.provider ?? ""); setExplorer(NETWORKS[network].explorer); }}>{custom ? t("common.cancel") : t("wallet.panel.change")}</Button></Row>
   {custom && <Block>
    <input aria-label={t("wallet.ark.providerInput")} className={`${input} font-mono text-xs`} value={provider} onChange={e => setProvider(e.target.value)} spellCheck={false} />
    <input aria-label={t("wallet.ark.explorer")} className={`${input} font-mono text-xs`} value={explorer} onChange={e => setExplorer(e.target.value)} spellCheck={false} />
    <Button variant="primary" disabled={busy} onClick={() => void run(async () => { await use(network, { provider, explorer }); setCustom(false); })}>{t("wallet.ark.useProvider")}</Button>
   </Block>}
   <Row label={t("wallet.panel.autoRenewal")} hint={network === "regtest" ? t("wallet.ark.renewalRegtest") : t("wallet.ark.renewalOpen")} value={network === "regtest" ? t("wallet.panel.off") : t("wallet.panel.on")} />
   <BackupRows name="Ark" busy={busy} run={run} canReplace={canReplace} focusFirst={backupNow}
    reveal={async () => (await wallet.arkBackup()).mnemonic} exportBackup={pw => wallet.arkExportBackup(pw)}
    restorePhrase={mnemonic => use(network, { provider: ark.provider, explorer: NETWORKS[network].explorer, mnemonic })} restoreFile={(text, pw) => wallet.arkRestoreBackup(text, pw)} /></>}
  </Section>}
 </div>;
}
