import { useEffect, useRef, useState } from "react";
import { paymentUri } from "@ghostly/core";
import type { FederationInfo } from "@ghostly/browser/engine/paymentAdapters/fedimintSdk";
import type { WalletPlatform, WalletState } from "../lib/platform";
import { Actions, Address, Amount, Block, Button, Notice, Row, Section, input, type Action } from "./wallet/ui";
import { useRun, downloadJson } from "./wallet/run";
import { Select } from "./ui/Select";
import { ConfirmRealMoney } from "./ConfirmRealMoney";
import { useI18n, type Translate } from "../contexts/I18nContext";
import { satsIn } from "./NetworkTag";
import { formatAmount } from "../lib/amount";
import { errorText } from "../lib/errorText";

const short = (id: string) => `${id.slice(0, 8)}…${id.slice(-4)}`;
/** A history row's kind, in the app's language (the engine's own word when it is a new one). */
const kindOf = (t: Translate, kind: string) => {
  switch (kind) {
    case "notes-out": return t("wallet.fedimint.kind.notesOut");
    case "notes-in": return t("wallet.fedimint.kind.notesIn");
    case "lightning-in": return t("wallet.fedimint.kind.lightningIn");
    case "lightning-out": return t("wallet.fedimint.kind.lightningOut");
    case "onchain": return t("wallet.fedimint.kind.onchain");
    default: return kind;
  }
};
/** A history row's state, in the app's language. */
const stateOf = (t: Translate, state: string) => {
  switch (state) {
    case "pending": return t("wallet.fedimint.state.pending");
    case "done": return t("wallet.fedimint.state.done");
    case "failed": return t("wallet.fedimint.state.failed");
    case "taken-back": return t("wallet.fedimint.state.takenBack");
    default: return state;
  }
};

/** A history row's amount, signed, and its fee when there is one. */
const amountOf = (t: Translate, tx: { kind: string; amount?: number; fee?: number }) => {
  const amount = tx.amount !== undefined ? `${tx.kind.endsWith("out") ? "−" : "+"}${formatAmount(tx.amount, t.language)}` : "";
  return tx.fee ? t("wallet.fedimint.amountFee", { amount, fee: tx.fee }) : amount;
};

/** What a federation says about itself, before and after joining it. */
function FederationFacts({ info, testId }: { info: Pick<FederationInfo, "federationId" | "name" | "guardians" | "consensusVersion" | "network" | "modules" | "welcome">; testId: string }) {
  const { t } = useI18n();
  return <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs" data-testid={testId}>
    <dt className="text-text-muted">{t("wallet.fedimint.facts.name")}</dt><dd className="text-text-primary" data-testid={`${testId}-name`}>{info.name ?? t("wallet.fedimint.facts.noName")}</dd>
    <dt className="text-text-muted">{t("wallet.fedimint.facts.id")}</dt><dd className="font-mono text-text-secondary break-all">{info.federationId}</dd>
    <dt className="text-text-muted">{t("wallet.panel.network")}</dt><dd className="text-text-secondary" data-testid={`${testId}-network`}>{info.network ?? t("wallet.fedimint.facts.unknown")}</dd>
    <dt className="text-text-muted">{t("wallet.fedimint.facts.guardians")}</dt><dd className="text-text-secondary" data-testid={`${testId}-guardians`}>{t("wallet.fedimint.facts.guardianList", { count: info.guardians.length, names: info.guardians.map((g) => g.name).join(", ") })}</dd>
    <dt className="text-text-muted">{t("wallet.fedimint.facts.consensus")}</dt><dd className="text-text-secondary">{t("wallet.fedimint.facts.consensusValue", { version: info.consensusVersion, modules: info.modules.join(", ") })}</dd>
    {info.welcome && <><dt className="text-text-muted">{t("wallet.fedimint.facts.says")}</dt><dd className="text-text-secondary">{info.welcome}</dd></>}
  </dl>;
}

/**
 * Federations joined with an invite code, and their ecash. Receive: an invoice paid through the federation's
 * gateway, or notes someone handed over. Send: notes to hand over (they come back if nobody redeems them).
 */
export function FedimintWalletPanel({ wallet, state, backupNow = false }: { wallet: WalletPlatform; state: WalletState; backupNow?: boolean }) {
  const fm = state.fedimint;
  const { t } = useI18n();
  const { busy, error, setError, run } = useRun();
  const federations = fm?.federations ?? [];
  const [selected, setSelected] = useState<string | undefined>(undefined);
  const current = federations.find((f) => f.id === selected) ?? federations.find((f) => f.status === "ready") ?? federations[0];
  const [action, setAction] = useState<Action>("receive");
  const [invite, setInvite] = useState(""), [preview, setPreview] = useState<FederationInfo | null>(null), [joining, setJoining] = useState(false);
  const [amount, setAmount] = useState(""), [invoice, setInvoice] = useState(""), [notesIn, setNotesIn] = useState(""), [received, setReceived] = useState("");
  const [notesOut, setNotesOut] = useState<{ notes: string; operation: string; federation: string } | null>(null);
  const [restoreInvites, setRestoreInvites] = useState(""), [phrase, setPhrase] = useState(""), [shownPhrase, setShownPhrase] = useState("");
  const [password, setPassword] = useState(""), [file, setFile] = useState(""), [filePassword, setFilePassword] = useState(""), [open, setOpen] = useState<"none" | "backup" | "restore">("none");
  const test = current ? current.network !== "bitcoin" : state.mode === "testnet";
  const unit = satsIn(t, test ? "testnet" : "mainnet");
  const ready = current?.status === "ready";
  const lnSource = state.lightning?.providerId === "fedimint";
  const [confirming, setConfirming] = useState(false);
  // The backup reminder's button leads here: the recovery phrase's Show takes the focus.
  const showPhrase = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const el = showPhrase.current;
    if (!backupNow || !el) return;
    el.scrollIntoView?.({ block: "center" });
    el.focus({ preventScroll: true });
  }, [backupNow]);
  // Real money when the federation says Bitcoin or this is the Mainnet wallet (the engine's rule too).
  const real = current?.network === "bitcoin" || state.mode === "mainnet";
  const spend = (confirmedReal: boolean) => { const id = current!.id; void run(async () => setNotesOut({ ...(await wallet.fedimintSpendNotes(id, Number(amount), confirmedReal || undefined)), federation: id })).finally(() => setConfirming(false)); };

  const join = <Section title={federations.length ? t("wallet.fedimint.joinAnother") : t("wallet.fedimint.join")}>
    <Block>
      <p className="text-xs text-text-muted">{t("wallet.fedimint.about")}</p>
      <textarea aria-label={t("wallet.fedimint.inviteInput")} data-testid="fedimint-invite" rows={2} spellCheck={false} placeholder="fed1…" className={`${input} font-mono text-xs resize-none`} value={invite}
        onChange={(e) => { setInvite(e.target.value.trim()); setPreview(null); }} />
      {!preview ? <Button data-testid="fedimint-preview" disabled={busy || !invite} onClick={() => void run(async () => setPreview(await wallet.fedimintPreview(invite)))}>{busy ? t("wallet.fedimint.asking") : t("wallet.fedimint.look")}</Button>
        : <div className="space-y-3">
          <FederationFacts info={preview} testId="fedimint-preview-facts" />
          {!preview.modules.includes("ln") && <Notice tone="warning">{t("wallet.fedimint.noLightning")}</Notice>}
          <div className="flex gap-2">
            <Button variant="primary" data-testid="fedimint-join" disabled={busy || joining} onClick={() => { setJoining(true); void run(async () => { const joined = await wallet.fedimintJoin(invite); setSelected(joined.id); setInvite(""); setPreview(null); }).finally(() => setJoining(false)); }}>{joining ? t("wallet.fedimint.joining") : preview.name ? t("wallet.fedimint.joinName", { name: preview.name }) : t("wallet.fedimint.joinThis")}</Button>
            <Button onClick={() => setPreview(null)}>{t("common.cancel")}</Button>
          </div>
        </div>}
    </Block>
  </Section>;

  return <div className="space-y-6" data-testid="fedimint-wallet">
    {!federations.length ? <div className="bg-surface rounded-xl p-6 text-center space-y-2" data-testid="fedimint-empty"><p className="text-text-primary">{t("wallet.fedimint.empty")}</p><Notice>{t("wallet.fedimint.emptyNote")}</Notice></div>
    : <div className="space-y-4">
      {federations.length > 1 && <Select aria-label={t("wallet.fedimint.federation")} value={current?.id ?? ""} onChange={(id) => { setSelected(id); setInvoice(""); setNotesOut(null); }}
        options={federations.map((f) => ({ value: f.id, label: f.name ?? short(f.id), description: `${formatAmount(f.balance, t.language)} ${unit}` }))} />}
      {current && <>
        <p className="text-text-primary" data-testid="fedimint-balance"><span className="text-4xl font-semibold tabular-nums">{formatAmount(current.balance, t.language)}</span><span className="text-text-muted text-sm ms-2">{unit}</span>
          <span className={`block text-xs mt-1 ${test ? "text-yellow-500" : "text-text-muted"}`}>{t(test ? "wallet.fedimint.lineTest" : "wallet.fedimint.line", { name: current.name ?? short(current.id), network: current.network ?? t("wallet.fedimint.unknownNetwork") })}</span></p>
        {current.status !== "ready" && <Notice tone={current.status === "error" ? "warning" : "muted"} testId="fedimint-status">{current.status === "error" ? t("wallet.fedimint.notAnswering", { error: current.error ? errorText(current.error, t) : t("wallet.fedimint.unknownError") }) : t("wallet.fedimint.connecting")}</Notice>}
        {federations.length > 1 && <Notice>{t("wallet.fedimint.across", { amount: formatAmount(fm!.balance, t.language), unit, count: federations.length })}</Notice>}
        <Actions value={action} onChange={(next) => { setAction(next); setError(""); }} actions={["receive", "send", "history"]} />
        {action === "receive" && <div className="bg-surface rounded-xl p-4 space-y-4 animate-fade-in">
          {current.lightning && <>
            <p className="text-xs text-text-secondary">{t("wallet.fedimint.lnReceive")}</p>
            <Amount value={amount} onChange={(v) => { setAmount(v); setInvoice(""); }} unit={unit} testId="fedimint-receive-amount" />
            {!invoice ? <Button variant="primary" className="w-full" data-testid="fedimint-receive-invoice" disabled={busy || !ready || !Number(amount)} onClick={() => void run(async () => setInvoice((await wallet.fedimintInvoice(current.id, Number(amount))).invoice))}>{t("wallet.fedimint.createInvoice")}</Button>
              : <Address value={invoice} uri={paymentUri({ kind: "lightning", invoice })} testId="fedimint-invoice" note={t("wallet.fedimint.invoiceNote")} />}
          </>}
          <div className="space-y-2">
            <p className="text-xs text-text-secondary">{t("wallet.fedimint.notesIn")}</p>
            <textarea aria-label={t("wallet.fedimint.notesInInput")} data-testid="fedimint-notes-in" rows={2} spellCheck={false} className={`${input} font-mono text-xs resize-none`} value={notesIn} onChange={(e) => { setNotesIn(e.target.value.trim()); setReceived(""); }} />
            <Button data-testid="fedimint-redeem" disabled={busy || !notesIn} onClick={() => void run(async () => { const r = await wallet.fedimintReceiveNotes(notesIn); setNotesIn(""); setReceived(t("wallet.fedimint.redeemed", { amount: formatAmount(r.amount, t.language), unit })); })}>{t("wallet.fedimint.redeem")}</Button>
            {received && <Notice tone="success" testId="fedimint-redeemed">{received}</Notice>}
          </div>
        </div>}
        {action === "send" && <div className="bg-surface rounded-xl p-4 space-y-3 animate-fade-in">
          <p className="text-xs text-text-secondary">{t("wallet.fedimint.sendAbout")}</p>
          <Amount value={amount} onChange={(v) => { setAmount(v); setNotesOut(null); setConfirming(false); }} unit={unit} testId="fedimint-send-amount" />
          {!notesOut ? (confirming ? <ConfirmRealMoney what={t("wallet.fedimint.asNotes", { amount: formatAmount(Number(amount), t.language) })} busy={busy} onSend={() => spend(true)} onBack={() => setConfirming(false)} />
            // Notes of a Mainnet federation are real money: the second step first, as for every other spend.
            : <Button variant="primary" className="w-full" data-testid="fedimint-spend" disabled={busy || !ready || !Number(amount) || Number(amount) > current.balance} onClick={() => (real ? setConfirming(true) : spend(false))}>{Number(amount) > current.balance ? t("wallet.fedimint.tooMuch") : t("wallet.fedimint.createNotes")}</Button>)
            : <div className="space-y-2">
              <Address value={notesOut.notes} testId="fedimint-notes-out" note={t("wallet.fedimint.notesOutNote")} />
              <Button data-testid="fedimint-take-back" disabled={busy} onClick={() => void run(async () => { const state = await wallet.fedimintTakeBack(notesOut.federation, notesOut.operation); if (state === "pending") throw new Error(t("wallet.fedimint.notAnswered")); setNotesOut(null); setReceived(state === "canceled" ? t("wallet.fedimint.takenBack") : t("wallet.fedimint.alreadyRedeemed")); })}>{t("wallet.fedimint.takeBack")}</Button>
            </div>}
        </div>}
        {action === "history" && <div className="bg-surface rounded-xl p-2 animate-fade-in" data-testid="fedimint-history">
          {!(fm?.history ?? []).length ? <p className="text-xs text-text-muted p-2">{t("wallet.fedimint.nothingYet")}</p> : (fm!.history.filter((tx) => federations.length < 2 || tx.federation === current.id)).map((tx) => (
            <div key={tx.id} className="flex items-center gap-3 px-2 py-2 text-sm border-b border-border last:border-0" data-testid="fedimint-tx">
              <span className="flex-1 text-text-primary">{tx.paymentId && !tx.paymentId.startsWith("wallet-") ? t("wallet.fedimint.kindChat", { kind: kindOf(t, tx.kind) }) : kindOf(t, tx.kind)}</span>
              <span className="tabular-nums text-text-secondary">{amountOf(t, tx)}</span>
              <span className="text-xs text-text-muted w-20 text-end">{stateOf(t, tx.state)}</span>
            </div>))}
        </div>}
        {received && action !== "receive" && <Notice tone="success">{received}</Notice>}
      </>}
    </div>}
    {error && <Notice tone="error">{error}</Notice>}
    {join}
    {federations.length > 0 && <Section title={t("wallet.panel.settings")}>
      {current && <>
        <Row label={t("wallet.fedimint.thisFederation")} hint={current.guardians.length === 1 ? t("wallet.fedimint.guardiansOne", { version: current.consensusVersion }) : t("wallet.fedimint.guardians", { count: current.guardians.length, version: current.consensusVersion })}><span className="text-xs font-mono text-text-secondary">{short(current.id)}</span></Row>
        <Block><FederationFacts info={{ ...current, federationId: current.id }} testId="fedimint-facts" /></Block>
        {current.lightning && <Row label="Lightning" hint={lnSource ? t("wallet.fedimint.lnHintUsed") : t("wallet.fedimint.lnHint")}>
          <Button data-testid="fedimint-use-lightning" disabled={busy || !ready} onClick={() => void run(() => wallet.lightningSetSource("fedimint", { federation: current.id }))}>{lnSource && state.lightning?.alias === current.name ? t("wallet.panel.inUse") : t("wallet.fedimint.useForLightning")}</Button>
        </Row>}
        <Row label={t("wallet.fedimint.leave")} hint={t("wallet.fedimint.leaveHint")}><Button data-testid="fedimint-leave" disabled={busy || current.balance > 0} onClick={() => void run(() => wallet.fedimintLeave(current.id))}>{t("wallet.fedimint.leave")}</Button></Row>
      </>}
      <Row label={t("wallet.fedimint.phrase")} hint={t("wallet.fedimint.phraseHint")}><Button ref={showPhrase} disabled={busy} onClick={() => shownPhrase ? setShownPhrase("") : void run(async () => setShownPhrase((await wallet.fedimintBackup()).mnemonic))}>{shownPhrase ? t("wallet.fedimint.hide") : t("wallet.fedimint.show")}</Button></Row>
      {shownPhrase && <Block><p className="select-all text-sm font-mono text-text-primary break-words" data-testid="fedimint-recovery">{shownPhrase}</p></Block>}
      <Row label={t("wallet.fedimint.backup")} hint={t("wallet.fedimint.backupHint")}><Button onClick={() => setOpen(open === "backup" ? "none" : "backup")}>{open === "backup" ? t("common.cancel") : t("wallet.fedimint.download")}</Button></Row>
      {open === "backup" && <Block>
        <input aria-label={t("wallet.fedimint.backupPassword")} type="password" autoComplete="new-password" placeholder={t("wallet.fedimint.backupPasswordPlaceholder")} className={input} value={password} onChange={(e) => setPassword(e.target.value)} />
        <Button variant="primary" disabled={busy || password.length < 12} onClick={() => void run(async () => { downloadJson(await wallet.fedimintExportBackup(password), "ghostly-fedimint-backup.json"); setPassword(""); setOpen("none"); })}>{t("wallet.fedimint.download")}</Button>
      </Block>}
    </Section>}
    <Section title={t("wallet.fedimint.restore")}>
      <Row label={t("wallet.fedimint.fromBackup")} hint={federations.length ? t("wallet.fedimint.fromBackupHintJoined") : t("wallet.fedimint.fromBackupHint")}><Button disabled={!!federations.length && open !== "restore"} onClick={() => setOpen(open === "restore" ? "none" : "restore")}>{open === "restore" ? t("common.cancel") : t("wallet.fedimint.restore")}</Button></Row>
      {open === "restore" && <Block>
        <textarea aria-label={t("wallet.fedimint.phraseInput")} rows={2} spellCheck={false} placeholder={t("wallet.fedimint.phrase")} className={`${input} font-mono resize-none`} value={phrase} onChange={(e) => setPhrase(e.target.value)} />
        <textarea aria-label={t("wallet.fedimint.invitesInput")} rows={2} spellCheck={false} placeholder={t("wallet.fedimint.invitesPlaceholder")} className={`${input} font-mono text-xs resize-none`} value={restoreInvites} onChange={(e) => setRestoreInvites(e.target.value)} />
        <Button variant="primary" disabled={busy || !phrase.trim() || !restoreInvites.trim()} onClick={() => void run(async () => { const r = await wallet.fedimintRestorePhrase(phrase, restoreInvites.split(/\s+/).filter(Boolean)); setPhrase(""); setRestoreInvites(""); setOpen("none"); if (r.failed.length) throw new Error(t("wallet.fedimint.restoreFailed", { count: r.joined, failed: r.failed.join("; ") })); })}>{t("wallet.fedimint.restorePhrase")}</Button>
        <label className="block text-xs text-text-muted">{t("wallet.fedimint.fileInput")}
          <input type="file" accept="application/json,.json" className={`${input} mt-1`} onChange={(e) => { const f = e.target.files?.[0]; if (f && f.size <= 1024 * 1024) void f.text().then(setFile); }} />
        </label>
        {file && <><input aria-label={t("wallet.fedimint.filePassword")} type="password" className={input} placeholder={t("wallet.fedimint.filePasswordPlaceholder")} value={filePassword} onChange={(e) => setFilePassword(e.target.value)} />
          <Button variant="primary" disabled={busy || !filePassword} onClick={() => void run(async () => { const r = await wallet.fedimintRestoreBackup(file, filePassword); setFile(""); setFilePassword(""); setOpen("none"); if (r.failed.length) throw new Error(t("wallet.fedimint.restoreFailed", { count: r.joined, failed: r.failed.join("; ") })); })}>{t("wallet.fedimint.restoreBackup")}</Button></>}
        <Notice>{t("wallet.fedimint.restoreNote")}</Notice>
      </Block>}
    </Section>
  </div>;
}
