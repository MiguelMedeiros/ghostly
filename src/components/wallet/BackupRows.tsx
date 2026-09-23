import { useState } from "react";
import { Block, Button, Notice, Row, input } from "./ui";
import { downloadJson } from "./run";
import { InputGroup } from "../layout";

type Open = "none" | "phrase" | "backup" | "restore";

/** Recovery phrase, encrypted backup and restore: the same three rows for every self-custodial wallet. */
export function BackupRows({ name, reveal, exportBackup, restorePhrase, restoreFile, canReplace, busy, run }: {
  name: string; busy: boolean; canReplace: boolean;
  reveal: () => Promise<string>;
  exportBackup: (password: string) => Promise<string>;
  restorePhrase: (phrase: string) => Promise<void>;
  restoreFile: (text: string, password: string) => Promise<void>;
  run: (work: () => Promise<unknown>) => Promise<void>;
}) {
  const [open, setOpen] = useState<Open>("none");
  const [phrase, setPhrase] = useState(""), [password, setPassword] = useState(""), [restore, setRestore] = useState(""), [file, setFile] = useState(""), [filePassword, setFilePassword] = useState("");
  const toggle = (next: Open) => { setOpen(open === next ? "none" : next); setPhrase(""); setPassword(""); };
  const slug = name.toLowerCase();
  return (
    <>
      <Row label="Recovery phrase" hint="Anyone with it can spend this wallet">
        <Button onClick={() => open === "phrase" ? toggle("none") : void run(async () => { setPhrase(await reveal()); setOpen("phrase"); })} disabled={busy}>{open === "phrase" ? "Hide" : "Show"}</Button>
      </Row>
      {open === "phrase" && phrase && <Block><p className="select-all text-sm text-text-primary font-mono leading-relaxed break-words" data-testid={`${slug}-recovery`}>{phrase}</p></Block>}
      <Row label="Wallet backup" hint="This wallet only; the profile backup has everything">
        <Button onClick={() => toggle("backup")}>{open === "backup" ? "Cancel" : "Download"}</Button>
      </Row>
      {open === "backup" && (
        <Block>
          <InputGroup as="form" onSubmit={(e) => { e.preventDefault(); void run(async () => { downloadJson(await exportBackup(password), `ghostly-${slug}-backup.json`); toggle("none"); }); }}>
            <input aria-label={`${name} backup password`} type="password" autoComplete="new-password" placeholder="Backup password (12+ characters)" className={input} value={password} onChange={(e) => setPassword(e.target.value)} autoFocus />
            <Button type="submit" variant="primary" disabled={busy || password.length < 12}>Download</Button>
          </InputGroup>
        </Block>
      )}
      <Row label="Restore" hint={canReplace ? undefined : "Only while empty"}>
        <Button onClick={() => toggle("restore")} disabled={!canReplace && open !== "restore"}>{open === "restore" ? "Cancel" : "Restore"}</Button>
      </Row>
      {open === "restore" && (
        <Block>
          <textarea aria-label="Recovery phrase" rows={2} autoComplete="off" spellCheck={false} placeholder="Recovery phrase" className={`${input} font-mono resize-none`} value={restore} onChange={(e) => setRestore(e.target.value)} />
          <Button variant="primary" disabled={busy || !restore.trim()} onClick={() => void run(async () => { await restorePhrase(restore.trim()); setRestore(""); toggle("none"); })}>Restore from phrase</Button>
          <label className="block text-xs text-text-muted">…or an encrypted backup file
            <input type="file" accept="application/json,.json" className={`${input} mt-1`} onChange={(e) => { const f = e.target.files?.[0]; if (f && f.size <= 16 * 1024 * 1024) void f.text().then(setFile); }} />
          </label>
          {file && (
            <InputGroup as="form" onSubmit={(e) => { e.preventDefault(); void run(async () => { await restoreFile(file, filePassword); setFile(""); setFilePassword(""); toggle("none"); }); }}>
              <input aria-label={`${name} backup file password`} type="password" className={input} placeholder="Backup password" value={filePassword} onChange={(e) => setFilePassword(e.target.value)} />
              <Button type="submit" variant="primary" disabled={busy || !filePassword}>Restore backup</Button>
            </InputGroup>
          )}
          <Notice>The current wallet is kept, archived.</Notice>
        </Block>
      )}
    </>
  );
}
