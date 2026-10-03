import { useState } from "react";
import { paymentUri, type PaymentReview as Review } from "@ghostly/core";
import type { WalletPlatform, WalletState } from "../lib/platform";
import { PaymentReview } from "./PaymentReview";
import { paymentStateLabel } from "./paymentWords";
import { BackupRows } from "./wallet/BackupRows";
import { Actions, Address, Amount, Block, Button, Notice, Row, Section, Segmented, input, type Action } from "./wallet/ui";
import { useRun } from "./wallet/run";
import { externalLinkProps } from "../lib/externalLink";
import { useI18n, type Translate } from "../contexts/I18nContext";
import { satsIn } from "./NetworkTag";
import { formatAmount } from "../lib/amount";

type Network = "bitcoin" | "signet" | "regtest";
/** Second's public servers (Bitcoin, signet), or a local regtest one (e2e/support/bark-regtest). */
const NETWORKS: Record<Network, { label: string; provider: string; explorer: string }> = {
 bitcoin: { label: "Bitcoin", provider: "https://ark.second.tech", explorer: "https://mempool.second.tech/api" },
 signet: { label: "Signet", provider: "https://ark.signet.2nd.dev", explorer: "https://esplora.signet.2nd.dev" },
 regtest: { label: "Regtest", provider: "http://127.0.0.1:47020", explorer: "http://127.0.0.1:47002" },
};
/** A test wallet may move between the test networks; a Mainnet one stays on Bitcoin. */
const TEST_NETWORKS: Network[] = ["signet", "regtest"];
/** Ten minutes a block, in days, rounded for a person. */
const days = (blocks: number) => Math.max(1, Math.round(blocks / 144));
/** Bark's out-of-round payments cost nothing today; the cap only stops a surprise, and the review shows the real fee. */
const feeCap = (amount: number) => Math.max(100, Math.ceil(amount / 100));

/**
 * Second's Ark: its own server, its own addresses. It pays Bark addresses of the same server, not Arkade ones.
 * `backupNow`: a Mainnet wallet just made with New opens on its backup rows, asking for a copy of its phrase first.
 */
export function BarkWalletPanel({ wallet, state, backupNow = false }: { wallet: WalletPlatform; state: WalletState; backupNow?: boolean }) {
 const bark = state.bark;
 const { t } = useI18n();
 const { busy, error, run } = useRun();
 const [action, setAction] = useState<Action>("receive");
 const [via, setVia] = useState<"ark" | "onchain">("ark");
 const [address, setAddress] = useState(""), [amount, setAmount] = useState(""), [review, setReview] = useState<Review | null>(null);
 const [custom, setCustom] = useState(false), [provider, setProvider] = useState(""), [explorer, setExplorer] = useState("");
 const network: Network = bark?.network ?? "signet";
 const real = network === "bitcoin";
 const unit = satsIn(t, bark?.network !== "bitcoin" ? "testnet" : "mainnet");
 const ready = !!bark?.configured && !bark.locked;
 const intents = (state.intents ?? []).filter(i => i.method === "bark");
 // Not answering (made, or never made because the server did not answer): another server can still be chosen.
 const stuck = !ready && (!!bark?.configured || !!bark?.error);
 const canReplace = intents.length === 0 && (stuck || (ready && !bark.balance && !bark.pending && !bark.exiting));
 const use = (next: Network, params: { provider?: string; explorer?: string; mnemonic?: string } = {}) => wallet.barkCreate({ network: next, provider: params.provider ?? NETWORKS[next].provider, explorer: params.explorer ?? NETWORKS[next].explorer, mnemonic: params.mnemonic });

 return <div className="space-y-6" data-testid="bark-wallet">
  {!ready ? <div className="bg-surface rounded-xl p-6 text-center space-y-2" data-testid="bark-connecting"><p className="text-text-primary">{t("wallet.panel.connecting", { wallet: "Bark" })}</p><Notice>{bark?.error ?? t("wallet.bark.connectingNote")}</Notice></div>
  : <div className="space-y-4">
   <p className="text-text-primary" data-testid="bark-balance"><span className="text-4xl font-semibold tabular-nums">{formatAmount(bark.balance, t.language)}</span><span className="text-text-muted text-sm ms-2">{unit}</span>{bark.network !== "bitcoin" && <span className="block text-xs text-yellow-500 mt-1">{t("wallet.bark.testCoins", { network: NETWORKS[network].label })}</span>}</p>
   {!!bark.pending && <Notice tone="warning" testId="bark-pending">{t("wallet.bark.pending", { amount: formatAmount(bark.pending, t.language), unit })}</Notice>}
   {!!bark.exiting && <Notice tone="warning" testId="bark-exiting">{t("wallet.bark.exiting", { amount: formatAmount(bark.exiting, t.language), unit })}</Notice>}
   {bark.scanning && <Notice testId="bark-scanning">{t("wallet.bark.scanning")}</Notice>}
   <Essentials t={t} expiry={bark.expiry} real={real} />
   <Actions value={action} onChange={setAction} />
   {action === "receive" && <div className="bg-surface rounded-xl p-4 space-y-4 animate-fade-in">
    <Segmented label={t("wallet.panel.receiveOn")} value={via} onChange={setVia} options={[{ value: "ark", label: t("wallet.panel.instant", { wallet: "Bark" }) }, { value: "onchain", label: t("wallet.panel.onchain") }]} />
    {via === "ark" ? <Address value={bark.address} uri={bark.address ? paymentUri({ kind: "ark", address: bark.address }) : undefined} testId="bark-address" note={t("wallet.bark.addressNote")} />
     : <Address value={bark.onchainAddress} qr={bark.onchainAddress ? `bitcoin:${bark.onchainAddress}` : undefined} testId="bark-onchain-address" note={t("wallet.bark.onchainNote")} />}
    {!!bark.onchain && <div className="flex items-center gap-3 rounded-xl bg-yellow-500/10 px-3 py-2" data-testid="bark-onchain">
     <p className="flex-1 text-xs text-yellow-500">{t("wallet.bark.onchain", { amount: formatAmount(bark.onchain, t.language), unit })}</p>
     <Button data-testid="bark-board" disabled={busy} onClick={() => void run(() => wallet.barkBoard())}>{busy ? t("wallet.bark.moving") : t("wallet.bark.board")}</Button>
    </div>}
   </div>}
   {action === "send" && <div className="bg-surface rounded-xl p-4 space-y-3 animate-fade-in">
    <input aria-label={t("wallet.panel.recipient", { wallet: "Bark" })} placeholder={t("wallet.panel.recipientPlaceholder", { wallet: "Bark" })} spellCheck={false} className={`${input} font-mono text-xs`} value={address} onChange={e => setAddress(e.target.value.trim())} />
    <Amount value={amount} onChange={setAmount} unit={unit} />
    <Button variant="primary" className="w-full" disabled={busy || !!review || !bark.balance || !address || !Number(amount)} onClick={() => void run(async () => { setReview(await wallet.preparePayment({ target: { method: "bark", network: bark.network!, provider: bark.provider!, asset: "BTC", unit: "sat", address, expiresAt: Date.now() + 5 * 60 * 1000 }, amount: Number(amount), feeCap: feeCap(Number(amount)), payee: address })); })}>{bark.balance ? t("wallet.panel.review") : t("wallet.panel.noBalance")}</Button>
    <Notice>{t("wallet.bark.approve")}</Notice>
   </div>}
   {review && <PaymentReview key={review.id} review={review} wallet={wallet} onClose={() => setReview(null)} />}
   {intents.filter(i => i.id !== review?.id).map(i => <Button key={i.id} className="block w-full text-start" onClick={() => setReview(i)}>{t("wallet.panel.intent", { amount: formatAmount(i.amount, t.language), unit, state: paymentStateLabel(t, i.state) })}</Button>)}
  </div>}
  {error && <Notice tone="error">{error}</Notice>}
  {bark?.error && ready && <Notice tone="warning">{bark.error}</Notice>}

  {(ready || stuck) && <Section title={t("wallet.panel.settings")} testId="bark-settings">
   {backupNow && real && ready && <Block><Notice tone="warning" testId="bark-backup-now">{t("wallet.bark.backupNow")}</Notice></Block>}
   {real ? <Row label={t("wallet.panel.network")} hint={t("wallet.bark.networkReal")}><span className="text-sm text-text-secondary" data-testid="bark-network">Bitcoin</span></Row>
   : <Row label={t("wallet.panel.network")} hint={stuck ? t("wallet.bark.serverStuck") : canReplace ? t("wallet.panel.testNetworks") : t("wallet.panel.onlyEmpty")}>
    <Segmented label={t("wallet.bark.networkLabel")} value={network} disabled={busy || !canReplace} options={TEST_NETWORKS.map(value => ({ value, label: NETWORKS[value].label }))} onChange={next => void run(() => use(next))} />
   </Row>}
   {ready && <><Row label={t("wallet.bark.server")} hint={bark.provider}><Button disabled={!canReplace} onClick={() => { setCustom(!custom); setProvider(bark.provider ?? ""); setExplorer(NETWORKS[network].explorer); }}>{custom ? t("common.cancel") : t("wallet.panel.change")}</Button></Row>
   {custom && <Block>
    <input aria-label={t("wallet.bark.serverInput")} className={`${input} font-mono text-xs`} value={provider} onChange={e => setProvider(e.target.value)} spellCheck={false} />
    <input aria-label={t("wallet.bark.esplora")} className={`${input} font-mono text-xs`} value={explorer} onChange={e => setExplorer(e.target.value)} spellCheck={false} />
    <Button variant="primary" disabled={busy} onClick={() => void run(async () => { await use(network, { provider, explorer }); setCustom(false); })}>{t("wallet.bark.useServer")}</Button>
   </Block>}
   <Row label={t("wallet.panel.autoRenewal")} hint={t("wallet.bark.renewalHint")}><span className="text-sm text-text-secondary">{t("wallet.panel.on")}</span></Row>
   {bark.terms && <Row label={t("wallet.bark.terms")} hint={t("wallet.bark.termsHint")}><a className="text-sm text-link underline" {...externalLinkProps(bark.terms)} data-testid="bark-terms">{t("wallet.bark.read")}</a></Row>}
   <BackupRows name="Bark" busy={busy} run={run} canReplace={canReplace} focusFirst={backupNow && real}
    reveal={async () => (await wallet.barkBackup()).mnemonic} exportBackup={pw => wallet.barkExportBackup(pw)}
    restorePhrase={mnemonic => use(network, { provider: bark.provider, explorer: NETWORKS[network].explorer, mnemonic })} restoreFile={(text, pw) => wallet.barkRestoreBackup(text, pw)} />
   <Notice>{t("wallet.bark.phraseNote")}</Notice></>}
  </Section>}
 </div>;
}

/**
 * What a Bark wallet asks of its owner, in two lines: coins expire unless renewed (Ghostly renews them while it is
 * open), and what is left if the server disappears.
 */
function Essentials({ t, expiry, real }: { t: Translate; expiry?: { blocksLeft?: number; lifetime?: number }; real: boolean }) {
 const left = expiry?.blocksLeft, soon = left !== undefined && left < 3 * 144;
 const lifetime = expiry?.lifetime ? days(expiry.lifetime) : undefined, next = left !== undefined && left >= 144 ? days(left) : undefined;
 return <div className="rounded-xl bg-surface px-3 py-2 space-y-1" data-testid="bark-essentials">
  <Notice tone={soon ? "warning" : "muted"} testId="bark-expiry">
   {lifetime === undefined ? t("wallet.bark.expiry.schedule") : lifetime === 1 ? t("wallet.bark.expiry.lifetimeOne") : t("wallet.bark.expiry.lifetime", { count: lifetime })}
   {t("wallet.bark.expiry.renews")}
   {left !== undefined && (next === undefined ? t("wallet.bark.expiry.nextSoon") : next === 1 ? t("wallet.bark.expiry.nextOne") : t("wallet.bark.expiry.next", { count: next }))}
  </Notice>
  <Notice testId="bark-exit">{real ? t("wallet.bark.exitReal") : t("wallet.bark.exit")}</Notice>
 </div>;
}
