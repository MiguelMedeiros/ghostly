import { useState } from "react";
import { paymentUri, type PaymentReview as Review } from "@ghostly/core";
import type { WalletPlatform, WalletState } from "../lib/platform";
import { PaymentReview } from "./PaymentReview";
import { BackupRows } from "./wallet/BackupRows";
import { Actions, Address, Amount, Block, Button, Notice, Row, Section, Segmented, input, type Action } from "./wallet/ui";
import { useRun } from "./wallet/run";

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
const days = (blocks: number) => { const n = Math.max(1, Math.round(blocks / 144)); return n === 1 ? "1 day" : `${n} days`; };
/** Bark's out-of-round payments cost nothing today; the cap only stops a surprise, and the review shows the real fee. */
const feeCap = (amount: number) => Math.max(100, Math.ceil(amount / 100));

/** Second's Ark: its own server, its own addresses. It pays Bark addresses of the same server, not Arkade ones. */
export function BarkWalletPanel({ wallet, state }: { wallet: WalletPlatform; state: WalletState }) {
 const bark = state.bark;
 const { busy, error, run } = useRun();
 const [action, setAction] = useState<Action>("receive");
 const [via, setVia] = useState<"ark" | "onchain">("ark");
 const [address, setAddress] = useState(""), [amount, setAmount] = useState(""), [review, setReview] = useState<Review | null>(null);
 const [custom, setCustom] = useState(false), [provider, setProvider] = useState(""), [explorer, setExplorer] = useState("");
 const network: Network = bark?.network ?? "signet";
 const real = network === "bitcoin";
 const unit = bark?.network !== "bitcoin" ? "test sats" : "sats";
 const ready = !!bark?.configured && !bark.locked;
 const intents = (state.intents ?? []).filter(i => i.method === "bark");
 // Not answering (made, or never made because the server did not answer): another server can still be chosen.
 const stuck = !ready && (!!bark?.configured || !!bark?.error);
 const canReplace = intents.length === 0 && (stuck || (ready && !bark.balance && !bark.pending && !bark.exiting));
 const use = (next: Network, params: { provider?: string; explorer?: string; mnemonic?: string } = {}) => wallet.barkCreate({ network: next, provider: params.provider ?? NETWORKS[next].provider, explorer: params.explorer ?? NETWORKS[next].explorer, mnemonic: params.mnemonic });

 return <div className="space-y-6" data-testid="bark-wallet">
  {!ready ? <div className="bg-surface rounded-xl p-6 text-center space-y-2" data-testid="bark-connecting"><p className="text-text-primary">Connecting your Bark wallet…</p><Notice>{bark?.error ?? "The first time loads Bark and asks the Ark server for its key."}</Notice></div>
  : <div className="space-y-4">
   <p className="text-text-primary" data-testid="bark-balance"><span className="text-4xl font-semibold tabular-nums">{bark.balance.toLocaleString()}</span><span className="text-text-muted text-sm ml-2">{unit}</span>{bark.network !== "bitcoin" && <span className="block text-xs text-yellow-500 mt-1">{NETWORKS[network].label} · Second's Ark · test coins, worthless</span>}</p>
   {!!bark.pending && <Notice tone="warning" testId="bark-pending">{bark.pending.toLocaleString()} {unit} pending (a round, a board or a Lightning payment): yours, not spendable yet</Notice>}
   {!!bark.exiting && <Notice tone="warning" testId="bark-exiting">{bark.exiting.toLocaleString()} {unit} on their way back on-chain (unilateral exit)</Notice>}
   <Essentials expiry={bark.expiry} real={real} />
   <Actions value={action} onChange={setAction} />
   {action === "receive" && <div className="bg-surface rounded-xl p-4 space-y-4 animate-fade-in">
    <Segmented label="Receive on" value={via} onChange={setVia} options={[{ value: "ark", label: "Bark (instant)" }, { value: "onchain", label: "Bitcoin on-chain" }]} />
    {via === "ark" ? <Address value={bark.address} uri={bark.address ? paymentUri({ kind: "ark", address: bark.address }) : undefined} testId="bark-address" note="From a Bark wallet on the same server. An Arkade wallet cannot pay it." />
     : <Address value={bark.onchainAddress} qr={bark.onchainAddress ? `bitcoin:${bark.onchainAddress}` : undefined} testId="bark-onchain-address" note="Send from any Bitcoin wallet, then move it into Ark once it confirms." />}
    {!!bark.onchain && <div className="flex items-center gap-3 rounded-xl bg-yellow-500/10 px-3 py-2" data-testid="bark-onchain">
     <p className="flex-1 text-xs text-yellow-500">{bark.onchain.toLocaleString()} {unit} on-chain, not in Ark yet. Moving them is an on-chain transaction: its fee comes off.</p>
     <Button data-testid="bark-board" disabled={busy} onClick={() => void run(() => wallet.barkBoard())}>{busy ? "Moving…" : "Move into Ark"}</Button>
    </div>}
   </div>}
   {action === "send" && <div className="bg-surface rounded-xl p-4 space-y-3 animate-fade-in">
    <input aria-label="Bark recipient address" placeholder="Recipient Bark address" spellCheck={false} className={`${input} font-mono text-xs`} value={address} onChange={e => setAddress(e.target.value.trim())} />
    <Amount value={amount} onChange={setAmount} unit={unit} />
    <Button variant="primary" className="w-full" disabled={busy || !!review || !bark.balance || !address || !Number(amount)} onClick={() => void run(async () => { setReview(await wallet.preparePayment({ target: { method: "bark", network: bark.network!, provider: bark.provider!, asset: "BTC", unit: "sat", address, expiresAt: Date.now() + 5 * 60 * 1000 }, amount: Number(amount), feeCap: feeCap(Number(amount)), payee: address })); })}>{bark.balance ? "Review payment" : "No balance to send yet"}</Button>
    <Notice>Nothing leaves before you approve. Only Bark addresses of this same server.</Notice>
   </div>}
   {review && <PaymentReview key={review.id} review={review} wallet={wallet} onClose={() => setReview(null)} />}
   {intents.filter(i => i.id !== review?.id).map(i => <Button key={i.id} className="block w-full text-left" onClick={() => setReview(i)}>{i.amount.toLocaleString()} sats · {i.state}</Button>)}
  </div>}
  {error && <Notice tone="error">{error}</Notice>}
  {bark?.error && ready && <Notice tone="warning">{bark.error}</Notice>}

  {(ready || stuck) && <Section title="Settings">
   {real ? <Row label="Network" hint="Real bitcoin, on Second's server"><span className="text-sm text-text-secondary" data-testid="bark-network">Bitcoin</span></Row>
   : <Row label="Network" hint={stuck ? "This server is not answering. You can switch to another one." : canReplace ? "Test networks use worthless coins." : "Only while this wallet is empty and has no payments."}>
    <Segmented label="Bark network" value={network} disabled={busy || !canReplace} options={TEST_NETWORKS.map(value => ({ value, label: NETWORKS[value].label }))} onChange={next => void run(() => use(next))} />
   </Row>}
   {ready && <><Row label="Ark server" hint={bark.provider}><Button disabled={!canReplace} onClick={() => { setCustom(!custom); setProvider(bark.provider ?? ""); setExplorer(NETWORKS[network].explorer); }}>{custom ? "Cancel" : "Change"}</Button></Row>
   {custom && <Block>
    <input aria-label="Bark server" className={`${input} font-mono text-xs`} value={provider} onChange={e => setProvider(e.target.value)} spellCheck={false} />
    <input aria-label="Bark Esplora API" className={`${input} font-mono text-xs`} value={explorer} onChange={e => setExplorer(e.target.value)} spellCheck={false} />
    <Button variant="primary" disabled={busy} onClick={() => void run(async () => { await use(network, { provider, explorer }); setCustom(false); })}>Use this server</Button>
   </Block>}
   <Row label="Automatic renewal" hint="Refreshes coins close to expiry while Ghostly is open"><span className="text-sm text-text-secondary">On</span></Row>
   {bark.terms && <Row label="Server terms" hint="Second's terms apply to its server"><a className="text-sm text-link underline" href={bark.terms} target="_blank" rel="noreferrer noopener" data-testid="bark-terms">Read</a></Row>}
   <BackupRows name="Bark" busy={busy} run={run} canReplace={canReplace}
    reveal={async () => (await wallet.barkBackup()).mnemonic} exportBackup={pw => wallet.barkExportBackup(pw)}
    restorePhrase={mnemonic => use(network, { provider: bark.provider, explorer: NETWORKS[network].explorer, mnemonic })} restoreFile={(text, pw) => wallet.barkRestoreBackup(text, pw)} />
   <Notice>The phrase brings back what Second's server holds for this wallet; payment history comes from the backup file.</Notice></>}
  </Section>}
 </div>;
}

/**
 * What a Bark wallet asks of its owner, in two lines: coins expire unless renewed (Ghostly renews them while it is
 * open), and what is left if the server disappears.
 */
function Essentials({ expiry, real }: { expiry?: { blocksLeft?: number; lifetime?: number }; real: boolean }) {
 const left = expiry?.blocksLeft, soon = left !== undefined && left < 3 * 144;
 return <div className="rounded-xl bg-surface px-3 py-2 space-y-1" data-testid="bark-essentials">
  <Notice tone={soon ? "warning" : "muted"} testId="bark-expiry">
   {expiry?.lifetime ? `Coins last about ${days(expiry.lifetime)} on this server. ` : "Coins expire on a schedule the server sets. "}
   Ghostly renews them close to expiry while it is open, so open it before then.
   {left !== undefined && ` The next one expires in ${left < 144 ? "less than a day" : `about ${days(left)}`}.`}
  </Notice>
  <Notice testId="bark-exit">If the server disappears, coins can still be taken back on-chain before they expire (a unilateral exit, paying on-chain fees), but Ghostly has no button for that yet{real ? ", so keep amounts small" : ""}.</Notice>
 </div>;
}
