import { useEffect, useRef, useState } from "react";
import { Block, Button, Notice, Row, input } from "./ui";
import { downloadJson } from "./run";
import { InputGroup } from "../layout";
import { useI18n } from "../../contexts/I18nContext";

type Open = "none" | "phrase" | "backup" | "restore";

/**
 * Recovery phrase, encrypted backup and restore: the same three rows for every self-custodial wallet. Without
 * `restorePhrase` and `restoreFile` (a backup before removing the wallet), only the first two. `focusFirst` (a wallet
 * just made, to back up now) scrolls the rows into view and puts the focus on the phrase's Show.
 */
export function BackupRows({ name, reveal, exportBackup, restorePhrase, restoreFile, canReplace = false, busy, run, focusFirst = false }: {
  name: string; busy: boolean; canReplace?: boolean; focusFirst?: boolean;
  reveal: () => Promise<string>;
  exportBackup: (password: string) => Promise<string>;
  restorePhrase?: (phrase: string) => Promise<void>;
  restoreFile?: (text: string, password: string) => Promise<void>;
  run: (work: () => Promise<unknown>) => Promise<void>;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState<Open>("none");
  const [phrase, setPhrase] = useState(""), [password, setPassword] = useState(""), [restore, setRestore] = useState(""), [file, setFile] = useState(""), [filePassword, setFilePassword] = useState("");
  const toggle = (next: Open) => { setOpen(open === next ? "none" : next); setPhrase(""); setPassword(""); };
  const slug = name.toLowerCase();
  const show = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const el = show.current;
    if (!focusFirst || !el) return;
    el.scrollIntoView?.({ block: "center" });
    el.focus({ preventScroll: true });
  }, [focusFirst]);
  return (
    <>
      <Row label={t("wallet.backup.phrase")} hint={t("wallet.backup.phraseHint")}>
        <Button ref={show} data-testid={`${slug}-recovery-show`} onClick={() => open === "phrase" ? toggle("none") : void run(async () => { setPhrase(await reveal()); setOpen("phrase"); })} disabled={busy}>{open === "phrase" ? t("wallet.backup.hide") : t("wallet.backup.show")}</Button>
      </Row>
      {open === "phrase" && phrase && <Block><p className="select-all text-sm text-text-primary font-mono leading-relaxed break-words" data-testid={`${slug}-recovery`}>{phrase}</p></Block>}
      <Row label={t("wallet.backup.file")} hint={t("wallet.backup.fileHint")}>
        <Button onClick={() => toggle("backup")}>{open === "backup" ? t("common.cancel") : t("wallet.backup.download")}</Button>
      </Row>
      {open === "backup" && (
        <Block>
          <InputGroup as="form" onSubmit={(e) => { e.preventDefault(); void run(async () => { if (await downloadJson(await exportBackup(password), `ghostly-${slug}-backup.json`)) toggle("none"); }); }}>
            <input aria-label={t("wallet.backup.passwordFor", { name })} type="password" autoComplete="new-password" placeholder={t("wallet.backup.newPassword")} className={input} value={password} onChange={(e) => setPassword(e.target.value)} autoFocus />
            <Button type="submit" variant="primary" disabled={busy || password.length < 12}>{t("wallet.backup.download")}</Button>
          </InputGroup>
        </Block>
      )}
      {restorePhrase && restoreFile && <Row label={t("wallet.backup.restore")} hint={canReplace ? undefined : t("wallet.backup.onlyEmpty")}>
        <Button onClick={() => toggle("restore")} disabled={!canReplace && open !== "restore"}>{open === "restore" ? t("common.cancel") : t("wallet.backup.restore")}</Button>
      </Row>}
      {open === "restore" && restorePhrase && restoreFile && (
        <Block>
          <textarea aria-label={t("wallet.backup.phrase")} rows={2} autoComplete="off" spellCheck={false} placeholder={t("wallet.backup.phrase")} className={`${input} font-mono resize-none`} value={restore} onChange={(e) => setRestore(e.target.value)} />
          <Button variant="primary" disabled={busy || !restore.trim()} onClick={() => void run(async () => { await restorePhrase(restore.trim()); setRestore(""); toggle("none"); })}>{t("wallet.backup.restorePhrase")}</Button>
          <label className="block text-xs text-text-muted">{t("wallet.backup.orFile")}
            <input type="file" accept="application/json,.json" className={`${input} mt-1`} onChange={(e) => { const f = e.target.files?.[0]; if (f && f.size <= 16 * 1024 * 1024) void f.text().then(setFile); }} />
          </label>
          {file && (
            <InputGroup as="form" onSubmit={(e) => { e.preventDefault(); void run(async () => { await restoreFile(file, filePassword); setFile(""); setFilePassword(""); toggle("none"); }); }}>
              <input aria-label={t("wallet.backup.filePasswordFor", { name })} type="password" className={input} placeholder={t("wallet.backup.password")} value={filePassword} onChange={(e) => setFilePassword(e.target.value)} />
              <Button type="submit" variant="primary" disabled={busy || !filePassword}>{t("wallet.backup.restoreFile")}</Button>
            </InputGroup>
          )}
          <Notice>{t("wallet.backup.kept")}</Notice>
        </Block>
      )}
    </>
  );
}
