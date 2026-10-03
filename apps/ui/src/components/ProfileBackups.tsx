import { useEffect, useRef, useState } from "react";
import { S3Store, type S3Config } from "@ghostly/browser/backup/s3";
import { backupName, newSpace, type StoredBackup } from "@ghostly/browser/backup/storage";
import { useSettings } from "../contexts/SettingsContext";
import { useI18n } from "../contexts/I18nContext";
import { backupProtectionOf, isCancelled, openProfileBackup, profileBackupSizes, restoreOpenedBackup, sameIdentityProfiles, writeProfileBackup, type BackupInput, type BackupResult, type BackupSizes, type OpenedProfileBackup } from "../lib/profileBackup";
import { backUpToFile, byteSize, stageBackup } from "../lib/backupFile";
import { switchProfile, type ProfileEntry } from "../lib/profiles";
import { guardRestore, restoreForTakeover, type RestoreGuard } from "../lib/restoreGuard";
import { Block, Button, Notice, Row, Section, Segmented, input } from "./wallet/ui";
import { useRun } from "./wallet/run";
import { useServicesPlatform } from "../hooks/useServicesPlatform";
import { useBackupJob } from "../hooks/useBackupJob";
import { BackupProgress } from "./BackupProgress";
import { Select } from "./ui/Select";
import { ButtonGroup, Field, FieldGrid, InputGroup, Truncate } from "./layout";

const EMPTY_S3: S3Config = { endpoint: "", region: "us-east-1", bucket: "", prefix: "ghostly", accessKeyId: "", secretAccessKey: "" };
type Open = "none" | "backup" | "restore" | "s3";
type Protection = "passphrase" | "none";
/** Everything, or a light backup: everything but the bytes of larger files (WISP 05 § Light backups). */
type Content = "everything" | "light";

/**
 * Backups of the whole profile (WISP 05) to a file or S3-compatible storage (WISP 1000). A restore always
 * becomes a new profile, then Ghostly switches to it. Both show their progress and can be cancelled.
 */
export function ProfileBackups({ canSwitch, openBackup = false }: { canSwitch: boolean; openBackup?: boolean }) {
  const { settings, updateBackupStorage } = useSettings();
  const { t, language } = useI18n();
  const { busy, error, setError, run } = useRun();
  const wallet = useServicesPlatform()?.wallet;
  const { job, start, saving, end, cancel } = useBackupJob();
  // `openBackup`: the wallet's backup reminder led here. Back up is open, and its passphrase takes the focus.
  const [open, setOpen] = useState<Open>(openBackup ? "backup" : "none");
  const first = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!openBackup) return;
    setOpen("backup");
    const el = first.current;
    el?.scrollIntoView?.({ block: "center" });
    el?.focus({ preventScroll: true });
  }, [openBackup]);
  const [passphrase, setPassphrase] = useState(""), [confirm, setConfirm] = useState("");
  // A backup is sealed with a passphrase unless the person chooses otherwise, and says so once more.
  const [protection, setProtection] = useState<Protection>("passphrase"), [understood, setUnderstood] = useState(false);
  const [done, setDone] = useState("");
  const [content, setContent] = useState<Content>("everything");
  // What each kind of backup would carry of the files' bytes, read from the file store once Back up is open.
  const [sizes, setSizes] = useState<BackupSizes | null>(null);
  useEffect(() => {
    if (open !== "backup") return;
    let current = true;
    void profileBackupSizes().then((found) => { if (current) setSizes(found); }).catch(() => {});
    return () => { current = false; };
  }, [open]);
  const [from, setFrom] = useState<"file" | "s3">("file");
  const [file, setFile] = useState<File | null>(null), [fileProtection, setFileProtection] = useState<Protection>("passphrase");
  const [listing, setListing] = useState<StoredBackup[] | null>(null), [picked, setPicked] = useState("");
  const [restorePass, setRestorePass] = useState("");
  // A backup of a profile still on this device (WISP 05 § Restoring on the same device) waits here for the person's choice.
  const [sameDevice, setSameDevice] = useState<{ opened: OpenedProfileBackup; originals: ProfileEntry[] } | null>(null);
  // A bundle whose profile may be active on another device (WISP 06 § A backup restored where a device set exists).
  const [guarded, setGuarded] = useState<{ opened: OpenedProfileBackup; guard: RestoreGuard } | null>(null);
  const [ownName, setOwnName] = useState("");
  const [draft, setDraft] = useState<S3Config>(settings.backupS3 ?? EMPTY_S3);
  const s3 = settings.backupS3 ? new S3Store(settings.backupS3) : null;
  const space = () => { if (settings.backupSpace) return settings.backupSpace; const fresh = newSpace(); updateBackupStorage({ backupSpace: fresh }); return fresh; };
  const toggle = (next: Open) => { setOpen(open === next ? "none" : next); setError(""); setDone(""); setSameDevice(null); setGuarded(null); if (next === "s3") setDraft(settings.backupS3 ?? EMPTY_S3); };
  const sealed = protection === "passphrase";
  const ready = sealed ? passphrase.length >= 12 && passphrase === confirm : understood;
  // Real money this profile has held on Mainnet: said by name before a file that anyone could spend it from is made.
  const realMoney = Object.values(wallet?.getState()?.backupReminders ?? {}).some((record) => record.funded !== undefined);

  /** What is said after a backup: where it went, and what could not go with it. */
  const madeText = (text: string, result: BackupResult) => [
    text,
    result.leftOut ? t("profile.backups.content.leftOut", { size: byteSize(result.leftOutBytes ?? 0) }) : "",
    result.skipped ? (result.skipped === 1 ? t("profile.backups.skippedOne") : t("profile.backups.skipped", { count: result.skipped })) : "",
  ].filter(Boolean).join(" ");
  /** Runs a backup or restore under the progress bar. Cancelled, it says so and nothing more. */
  const underProgress = (kind: "backup" | "restore", isSealed: boolean, work: (signal: ReturnType<typeof start>) => Promise<void>) => run(async () => {
    setDone("");
    try { await work(start(kind, isSealed)); } catch (e) {
      if (!isCancelled(e)) throw e;
      setDone(t(kind === "backup" ? "profile.backups.cancelled" : "profile.backups.restoreCancelled"));
    } finally { end(); }
  });

  const backup = (to: "file" | "s3") => underProgress("backup", sealed, async (watch) => {
    const options = { passphrase: sealed ? passphrase : null, light: content === "light", ...watch };
    const name = backupName(space());
    if (to === "s3" && s3) {
      // S3 takes the bundle in one signed request: it is staged as it is made, then read once to send.
      const staged = await stageBackup();
      try {
        const result = await writeProfileBackup(staged, options);
        saving();
        await s3.put(name, await staged.bytes());
        setDone(madeText(t("profile.backups.savedToS3", { size: byteSize(result.bytes) }), result));
      } finally { await staged.discard(); }
    } else {
      // The desktop app asks where to save it. Closing that dialog saves nothing: nothing is said to be saved, and
      // the passphrase stays to try again.
      const fileName = name.split("/").pop()!;
      const { how, result } = await backUpToFile(options, fileName, saving);
      if (how === "cancelled") return;
      setDone(madeText(t(how === "saved" ? "profile.backups.saved" : "profile.backups.downloaded", { name: fileName, size: byteSize(result.bytes) }), result));
    }
    setPassphrase(""); setConfirm(""); setUnderstood(false); setProtection("passphrase");
    // A copy of everything now: a wallet's backup reminder that asked for it is over.
    await wallet?.backupReminder({ event: "profile" }).catch(() => {});
  });

  // An empty file would leave Restore off with nothing said: say why instead. A file made without a passphrase asks for none.
  const pickFile = async (picked: File) => {
    setDone(""); setSameDevice(null);
    if (!picked.size) { setFile(null); setError(t("profile.backups.emptyFile")); return; }
    setError("");
    setFileProtection(await backupProtectionOf(picked).catch(() => "passphrase" as const));
    setFile(picked);
  };
  const needsPassphrase = from === "s3" && s3 ? true : fileProtection === "passphrase";
  const restore = () => underProgress("restore", true, async (watch) => {
    const bundle: BackupInput | null = from === "file" || !s3 ? file : await s3.get(picked);
    if (!bundle) throw new Error(t("profile.backups.chooseFirst"));
    const opened = await openProfileBackup(bundle, restorePass || undefined, watch);
    // The turn first: a copy of a profile that runs on another device does not start (WISP 06).
    const guard = await guardRestore(opened);
    if (guard.case !== "plain") { setOwnName(""); setGuarded({ opened, guard }); return; }
    await afterGuard(opened, watch);
  });
  /** The rest of a restore once the turn allows it: the same profile on this device, then the restore itself. */
  const afterGuard = async (opened: OpenedProfileBackup, watch: ReturnType<typeof start>) => {
    setGuarded(null);
    const originals = await sameIdentityProfiles(opened);
    if (originals.length) { setSameDevice({ opened, originals }); return; }
    await finish(opened, undefined, watch);
  };
  /** "Take over" from a restore: the copy is restored on standby here, and its screen offers the takeover. */
  const takeOver = (target: { opened: OpenedProfileBackup; guard: RestoreGuard }) => underProgress("restore", true, async (watch) => {
    const entry = await restoreForTakeover(target.opened, target.guard, watch);
    setRestorePass(""); setGuarded(null);
    if (canSwitch) switchProfile(entry.id, { route: "/" });
    else setDone(t("profile.backups.restored", { name: entry.name }));
  });
  /** `replacing`: the original, which the profile page of the copy then offers to remove, with its usual checks. */
  const finish = async (opened: OpenedProfileBackup, replacing: ProfileEntry | undefined, watch: ReturnType<typeof start>) => {
    const entry = await restoreOpenedBackup(opened, watch);
    setRestorePass(""); setSameDevice(null);
    if (canSwitch) switchProfile(entry.id, { route: replacing ? `/profile?replace=${encodeURIComponent(replacing.id)}` : "/profile" });
    else setDone(t("profile.backups.restored", { name: entry.name }));
  };
  // Replace needs the copy running and the original removable: never the first profile.
  const replaceable = canSwitch ? sameDevice?.originals.find((entry) => entry.id) : undefined;
  const firstOnly = !!sameDevice && !replaceable && sameDevice.originals.some((entry) => !entry.id);
  const unprotected = open === "restore" && (sameDevice ? sameDevice.opened.protection === "none" : (from === "file" || !s3) && !!file && fileProtection === "none");

  return (
    <Section title={t("profile.backups.title")} testId="profile-backups">
      {job && <BackupProgress job={job} onCancel={cancel} />}
      <Row label={t("profile.backups.backUp")} hint={t("profile.backups.backUpHint")} info={t("profile.backups.holds")}><Button data-testid="backup-open" onClick={() => toggle("backup")}>{open === "backup" ? t("common.close") : t("profile.backups.backUpOpen")}</Button></Row>
      {open === "backup" && (
        <Field testId="backup-content" label={t("profile.backups.content.label")} info={t("profile.backups.content.info")}
          hint={sizes && <span data-testid="backup-content-size">{content === "light" ? t("profile.backups.content.lightSize", { size: byteSize(sizes.light), left: byteSize(sizes.leftOutBytes) }) : t("profile.backups.content.everythingSize", { size: byteSize(sizes.everything) })}</span>}>
          <Segmented label={t("profile.backups.content.label")} value={content} onChange={setContent}
            options={[{ value: "everything", label: t("profile.backups.content.everything") }, { value: "light", label: t("profile.backups.content.light") }]} />
        </Field>
      )}
      {open === "backup" && (
        <Block>
          <Segmented label={t("profile.backups.protection.label")} value={protection} onChange={(next) => { setProtection(next); setUnderstood(false); setError(""); }}
            options={[{ value: "passphrase", label: t("profile.backups.protection.passphrase") }, { value: "none", label: t("profile.backups.protection.none") }]} />
          {sealed ? (
            <FieldGrid>
              <input ref={first} data-testid="backup-passphrase" type="password" autoComplete="new-password" className={input} placeholder={t("profile.backups.passphraseNew")} value={passphrase} onChange={(e) => setPassphrase(e.target.value)} />
              <input data-testid="backup-confirm" type="password" autoComplete="new-password" className={input} placeholder={t("profile.backups.repeat")} value={confirm} onChange={(e) => setConfirm(e.target.value)} />
            </FieldGrid>
          ) : (
            <div data-testid="backup-unprotected" className="space-y-2">
              <Notice tone="error" testId="backup-unprotected-warning">{t("profile.backups.protection.warning")}</Notice>
              {realMoney && <Notice tone="error" testId="backup-unprotected-mainnet">{t("profile.backups.protection.mainnet")}</Notice>}
              <label className="flex items-start gap-2 text-sm text-text-primary cursor-pointer">
                <input data-testid="backup-unprotected-confirm" type="checkbox" className="mt-0.5 accent-accent" checked={understood} onChange={(e) => setUnderstood(e.target.checked)} />
                <span>{t("profile.backups.protection.confirm")}</span>
              </label>
            </div>
          )}
          <ButtonGroup>
            <Button variant="primary" data-testid="backup-download" disabled={busy || !ready} onClick={() => void backup("file")}>{busy ? t("profile.backups.working") : t("profile.backups.download")}</Button>
            {/* A bundle anyone can read never goes to a server. */}
            {s3 && sealed && <Button data-testid="backup-s3" disabled={busy || !ready} onClick={() => void backup("s3")}>{t("profile.backups.saveToS3")}</Button>}
          </ButtonGroup>
          {sealed && <Notice>{t("profile.backups.spendWarning")}</Notice>}
        </Block>
      )}

      <Row label={t("profile.backups.restore")} hint={t("profile.backups.restoreHint")}><Button data-testid="restore-open" onClick={() => toggle("restore")}>{open === "restore" ? t("common.close") : t("profile.backups.restoreOpen")}</Button></Row>
      {open === "restore" && (
        <Block>
          {s3 && <Segmented label={t("profile.backups.restoreFrom")} value={from} onChange={(next) => { setFrom(next); setError(""); }} options={[{ value: "file", label: t("profile.backups.fromFile") }, { value: "s3", label: "S3" }]} />}
          {from === "file" || !s3 ? (
            <input data-testid="restore-file" type="file" accept=".ghostly-backup,application/json,application/octet-stream" className={input} onChange={(e) => { const f = e.target.files?.[0]; if (f) void pickFile(f); }} />
          ) : (
            <InputGroup>
              {listing?.length ? (
                <Select data-testid="restore-pick" aria-label={t("profile.backups.toRestore")} value={picked} onChange={setPicked}
                  options={listing.map((b) => ({ value: b.name, label: new Date(b.created || b.modified || 0).toLocaleString(language), description: b.size ? byteSize(b.size) : undefined }))} />
              ) : listing ? <Notice>{t("profile.backups.noneYet")}</Notice> : null}
              <Button data-testid="restore-list" disabled={busy} onClick={() => void run(async () => { const all = (await s3.list(space())).filter((b) => b.name.endsWith(".ghostly-backup")).reverse(); setListing(all); setPicked(all[0]?.name ?? ""); })}>{listing ? t("profile.backups.refresh") : t("profile.backups.list")}</Button>
            </InputGroup>
          )}
          {unprotected && <Notice tone="warning" testId="restore-unprotected">{t("profile.backups.unprotectedFile")}</Notice>}
          <InputGroup>
            {needsPassphrase && <input data-testid="restore-passphrase" type="password" autoComplete="current-password" className={input} placeholder={t("profile.backups.passphrase")} value={restorePass} onChange={(e) => setRestorePass(e.target.value)} />}
            <Button variant="primary" data-testid="restore-go" disabled={busy || (needsPassphrase && !restorePass) || !!sameDevice || !!guarded || (from === "file" || !s3 ? !file : !picked)} onClick={() => void restore()}>{busy ? t("profile.backups.restoring") : t("profile.backups.restore")}</Button>
          </InputGroup>
          {!sameDevice && <Notice>{t("profile.backups.keepOne")}</Notice>}
        </Block>
      )}
      {open === "restore" && guarded && (
        <Field testId="restore-guard" label={<span className="font-semibold" data-testid="restore-guard-title" data-case={guarded.guard.case}>{
          guarded.guard.case === "active" ? (guarded.guard.device ? t("devices.restore.activeOn", { device: guarded.guard.device }) : t("devices.restore.activeOnUnnamed"))
            : guarded.guard.case === "tombstone" ? t("devices.restore.tombstone") : t("devices.restore.unreadable")}</span>}
          hint={guarded.guard.case === "active" ? t("devices.restore.activeHint") : undefined}>
          {guarded.guard.case === "active" && (
            <ButtonGroup>
              <Button data-testid="restore-add-instead" disabled={busy} onClick={() => { setGuarded(null); setDone(t("devices.restore.addInsteadHint", { device: guarded.guard.device ?? t("devices.join.otherDevice") })); }}>{t("devices.restore.addInstead")}</Button>
              <Button variant="primary" data-testid="restore-take-over" disabled={busy} onClick={() => void takeOver(guarded)}>{t("devices.restore.takeOver")}</Button>
              <Button data-testid="restore-guard-cancel" disabled={busy} onClick={() => setGuarded(null)}>{t("common.cancel")}</Button>
            </ButtonGroup>
          )}
          {guarded.guard.case === "tombstone" && (
            <InputGroup>
              <input data-testid="restore-own-name" className={input} autoComplete="off" spellCheck={false} placeholder={t("devices.restore.tombstoneConfirm", { name: guarded.opened.name })}
                aria-label={t("devices.restore.tombstoneConfirm", { name: guarded.opened.name })} value={ownName} onChange={(e) => setOwnName(e.target.value)} />
              <Button variant="primary" data-testid="restore-own-go" disabled={busy || ownName.trim() !== guarded.opened.name.trim()} onClick={() => void underProgress("restore", true, (watch) => afterGuard(guarded.opened, watch))}>{t("devices.restore.tombstoneGo")}</Button>
              <Button data-testid="restore-guard-cancel" disabled={busy} onClick={() => setGuarded(null)}>{t("common.cancel")}</Button>
            </InputGroup>
          )}
          {guarded.guard.case === "unreadable" && (
            <ButtonGroup>
              <Button variant="primary" data-testid="restore-guard-retry" disabled={busy} onClick={() => { setGuarded(null); void restore(); }}>{t("devices.restore.tryAgain")}</Button>
              <Button data-testid="restore-guard-cancel" disabled={busy} onClick={() => setGuarded(null)}>{t("common.cancel")}</Button>
            </ButtonGroup>
          )}
        </Field>
      )}
      {open === "restore" && sameDevice && (
        // The original is on this device: both would answer contacts as the same person. The person chooses.
        <Field testId="restore-same-device" label={<span className="font-semibold">{t("profile.backups.sameDevice.title", { names: sameDevice.originals.map((entry) => `“${entry.name}”`).join(", ") })}</span>}
          hint={t("profile.backups.sameDevice.hint")} info={t("profile.backups.sameDevice.info")}>
          {firstOnly && <Notice>{t("profile.backups.sameDevice.firstProfile")}</Notice>}
          <ButtonGroup>
            {replaceable && <Button variant="primary" data-testid="restore-replace" disabled={busy} onClick={() => void underProgress("restore", true, (watch) => finish(sameDevice.opened, replaceable, watch))}>{t("profile.backups.sameDevice.replace")}</Button>}
            <Button data-testid="restore-copy" disabled={busy} onClick={() => void underProgress("restore", true, (watch) => finish(sameDevice.opened, undefined, watch))}>{t("profile.backups.sameDevice.copy")}</Button>
            <Button data-testid="restore-cancel" disabled={busy} onClick={() => setSameDevice(null)}>{t("common.cancel")}</Button>
          </ButtonGroup>
        </Field>
      )}

      <Row label={t("profile.backups.s3.title")} hint={s3 ? <Truncate>{s3.description.replace(/^S3 · /, "")}</Truncate> : t("profile.backups.off")}><Button data-testid="s3-setup" onClick={() => toggle("s3")}>{open === "s3" ? t("common.close") : s3 ? t("profile.backups.s3.edit") : t("profile.backups.setUp")}</Button></Row>
      {open === "s3" && (
        <Block>
          <FieldGrid>
            {([["endpoint", t("profile.backups.s3.endpoint")], ["bucket", t("profile.backups.s3.bucket")], ["accessKeyId", t("profile.backups.s3.accessKey")], ["secretAccessKey", t("profile.backups.s3.secretKey")], ["region", t("profile.backups.s3.region")], ["prefix", t("profile.backups.s3.folder")]] as const).map(([key, label]) => (
              <input key={key} data-testid={`s3-${key}`} aria-label={label} placeholder={label} spellCheck={false} autoComplete="off" type={key === "secretAccessKey" ? "password" : "text"} className={input}
                value={draft[key]} onChange={(e) => setDraft({ ...draft, [key]: e.target.value })} />
            ))}
          </FieldGrid>
          <ButtonGroup>
            <Button variant="primary" data-testid="s3-save" disabled={busy} onClick={() => void run(async () => { const store = new S3Store(draft); await store.test(space()); updateBackupStorage({ backupS3: draft }); setOpen("none"); setDone(t("profile.backups.connected", { store: store.description.replace(/^S3 · /, "") })); })}>{busy ? t("profile.backups.s3.testing") : t("profile.backups.s3.testAndSave")}</Button>
            {s3 && <Button variant="danger" onClick={() => { updateBackupStorage({ backupS3: null }); setOpen("none"); }}>{t("profile.backups.s3.remove")}</Button>}
          </ButtonGroup>
          <Notice>{t("profile.backups.s3.note")}</Notice>
        </Block>
      )}
      {(done || error) && <Block>{done && <Notice tone="success" testId="backup-done">{done}</Notice>}{error && <Notice tone="error" testId="backup-error">{error}</Notice>}</Block>}
    </Section>
  );
}
