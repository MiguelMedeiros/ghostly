import { useState } from "react";
import { S3Store, type S3Config } from "@ghostly/browser/backup/s3";
import { backupName, newSpace, type StoredBackup } from "@ghostly/browser/backup/storage";
import { useSettings } from "../contexts/SettingsContext";
import { createProfileBackup, restoreProfileBackup } from "../lib/profileBackup";
import { switchProfile } from "../lib/profiles";
import { Block, Button, Notice, Row, Section, Segmented, input } from "./wallet/ui";
import { useRun } from "./wallet/run";
import { ButtonGroup, FieldGrid, InputGroup, Truncate } from "./layout";

const size = (bytes: number) => (bytes > 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`);
const EMPTY_S3: S3Config = { endpoint: "", region: "us-east-1", bucket: "", prefix: "ghostly", accessKeyId: "", secretAccessKey: "" };
type Open = "none" | "backup" | "restore" | "s3";

/**
 * Backups of the whole profile (WISP 05) to a file or S3-compatible storage (WISP 1000). A restore always
 * becomes a new profile, then Ghostly switches to it.
 */
export function ProfileBackups({ canSwitch }: { canSwitch: boolean }) {
  const { settings, updateBackupStorage } = useSettings();
  const { busy, error, setError, run } = useRun();
  const [open, setOpen] = useState<Open>("none");
  const [passphrase, setPassphrase] = useState(""), [confirm, setConfirm] = useState("");
  const [done, setDone] = useState("");
  const [from, setFrom] = useState<"file" | "s3">("file");
  const [file, setFile] = useState<string | null>(null);
  const [listing, setListing] = useState<StoredBackup[] | null>(null), [picked, setPicked] = useState("");
  const [restorePass, setRestorePass] = useState("");
  const [draft, setDraft] = useState<S3Config>(settings.backupS3 ?? EMPTY_S3);
  const s3 = settings.backupS3 ? new S3Store(settings.backupS3) : null;
  const space = () => { if (settings.backupSpace) return settings.backupSpace; const fresh = newSpace(); updateBackupStorage({ backupSpace: fresh }); return fresh; };
  const toggle = (next: Open) => { setOpen(open === next ? "none" : next); setError(""); setDone(""); if (next === "s3") setDraft(settings.backupS3 ?? EMPTY_S3); };
  const ready = passphrase.length >= 12 && passphrase === confirm;

  const backup = (to: "file" | "s3") => run(async () => {
    const bytes = new TextEncoder().encode(await createProfileBackup(passphrase));
    const name = backupName(space());
    if (to === "s3" && s3) { await s3.put(name, bytes); setDone(`Saved to S3 · ${size(bytes.length)}`); }
    else {
      const url = URL.createObjectURL(new Blob([bytes], { type: "application/vnd.ghostly.backup+json" }));
      const link = document.createElement("a"); link.href = url; link.download = name.split("/").pop()!; link.click();
      setTimeout(() => URL.revokeObjectURL(url), 2000);
      setDone(`Downloaded · ${size(bytes.length)}`);
    }
    setPassphrase(""); setConfirm("");
  });
  const restore = () => run(async () => {
    const text = from === "file" ? file : new TextDecoder().decode(await s3!.get(picked));
    if (!text) throw new Error("Choose a backup first");
    const entry = await restoreProfileBackup(text, restorePass);
    setRestorePass("");
    if (canSwitch) switchProfile(entry.id); else setDone(`Restored as “${entry.name}”.`);
  });

  return (
    <Section title="Backups" testId="profile-backups">
      <Row label="Back up" hint="The whole profile, sealed with a passphrase"><Button data-testid="backup-open" onClick={() => toggle("backup")}>{open === "backup" ? "Close" : "Back up…"}</Button></Row>
      {open === "backup" && (
        <Block>
          <FieldGrid>
            <input data-testid="backup-passphrase" type="password" autoComplete="new-password" className={input} placeholder="Passphrase (12+)" value={passphrase} onChange={(e) => setPassphrase(e.target.value)} />
            <input data-testid="backup-confirm" type="password" autoComplete="new-password" className={input} placeholder="Repeat" value={confirm} onChange={(e) => setConfirm(e.target.value)} />
          </FieldGrid>
          <ButtonGroup>
            <Button variant="primary" data-testid="backup-download" disabled={busy || !ready} onClick={() => void backup("file")}>{busy ? "Working…" : "Download"}</Button>
            {s3 && <Button data-testid="backup-s3" disabled={busy || !ready} onClick={() => void backup("s3")}>Save to S3</Button>}
          </ButtonGroup>
          <Notice>Whoever has the file and the passphrase can spend its wallets.</Notice>
        </Block>
      )}

      <Row label="Restore" hint="Becomes a new profile"><Button data-testid="restore-open" onClick={() => toggle("restore")}>{open === "restore" ? "Close" : "Restore…"}</Button></Row>
      {open === "restore" && (
        <Block>
          {s3 && <Segmented label="Restore from" value={from} onChange={(next) => { setFrom(next); setError(""); }} options={[{ value: "file", label: "File" }, { value: "s3", label: "S3" }]} />}
          {from === "file" || !s3 ? (
            <input data-testid="restore-file" type="file" accept=".ghostly-backup,application/json" className={input} onChange={(e) => { const f = e.target.files?.[0]; if (f) void f.text().then(setFile); }} />
          ) : (
            <InputGroup>
              {listing?.length ? (
                <select data-testid="restore-pick" aria-label="Backup to restore" className={input} value={picked} onChange={(e) => setPicked(e.target.value)}>
                  {listing.map((b) => <option key={b.name} value={b.name}>{new Date(b.created || b.modified || 0).toLocaleString()}{b.size ? ` · ${size(b.size)}` : ""}</option>)}
                </select>
              ) : listing ? <Notice>None yet.</Notice> : null}
              <Button data-testid="restore-list" disabled={busy} onClick={() => void run(async () => { const all = (await s3.list(space())).filter((b) => b.name.endsWith(".ghostly-backup")).reverse(); setListing(all); setPicked(all[0]?.name ?? ""); })}>{listing ? "Refresh" : "List"}</Button>
            </InputGroup>
          )}
          <InputGroup>
            <input data-testid="restore-passphrase" type="password" autoComplete="current-password" className={input} placeholder="Passphrase" value={restorePass} onChange={(e) => setRestorePass(e.target.value)} />
            <Button variant="primary" data-testid="restore-go" disabled={busy || !restorePass || (from === "file" || !s3 ? !file : !picked)} onClick={() => void restore()}>{busy ? "Restoring…" : "Restore"}</Button>
          </InputGroup>
          <Notice>Original still here? Keep using just one: they share wallets.</Notice>
        </Block>
      )}

      <Row label="S3 storage" hint={s3 ? <Truncate>{s3.description.replace(/^S3 · /, "")}</Truncate> : "Off"}><Button data-testid="s3-setup" onClick={() => toggle("s3")}>{open === "s3" ? "Close" : s3 ? "Edit" : "Set up"}</Button></Row>
      {open === "s3" && (
        <Block>
          <FieldGrid>
            {([["endpoint", "Endpoint (https://…)"], ["bucket", "Bucket"], ["accessKeyId", "Access key"], ["secretAccessKey", "Secret key"], ["region", "Region"], ["prefix", "Folder"]] as const).map(([key, label]) => (
              <input key={key} data-testid={`s3-${key}`} aria-label={label} placeholder={label} spellCheck={false} autoComplete="off" type={key === "secretAccessKey" ? "password" : "text"} className={input}
                value={draft[key]} onChange={(e) => setDraft({ ...draft, [key]: e.target.value })} />
            ))}
          </FieldGrid>
          <ButtonGroup>
            <Button variant="primary" data-testid="s3-save" disabled={busy} onClick={() => void run(async () => { const store = new S3Store(draft); await store.test(space()); updateBackupStorage({ backupS3: draft }); setOpen("none"); setDone(`Connected · ${store.description.replace(/^S3 · /, "")}`); })}>{busy ? "Testing…" : "Test and save"}</Button>
            {s3 && <Button variant="danger" onClick={() => { updateBackupStorage({ backupS3: null }); setOpen("none"); }}>Remove</Button>}
          </ButtonGroup>
          <Notice>Keys stay on this device. The bucket must allow this app in its CORS rules.</Notice>
        </Block>
      )}
      {(done || error) && <Block>{done && <Notice tone="success" testId="backup-done">{done}</Notice>}{error && <Notice tone="error" testId="backup-error">{error}</Notice>}</Block>}
    </Section>
  );
}
