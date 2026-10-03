import { useCallback, useEffect, useRef, useState } from "react";
import type { BackupProgress, BackupRun } from "../lib/profileBackup";

/** A backup or a restore under way: what it is doing now. `saving`: the bundle is made, the file is being saved. */
export interface BackupJob {
  kind: "backup" | "restore";
  /** Whether the bundle is encrypted as it is written (a backup without a passphrase only writes). */
  sealed: boolean;
  stage: BackupProgress["stage"] | "saving";
  files: number;
  filesTotal: number;
  bytes: number;
  bytesTotal: number;
}

/** The bar moves at most this often: a large file reports every megabyte. */
const TELL_EVERY_MS = 100;

/**
 * One backup or restore at a time, with its progress and a way to stop it. `start` gives the run its signal and its
 * progress callback; `cancel` aborts it (the run then throws an `AbortError` and cleans up after itself).
 */
export function useBackupJob() {
  const [job, setJob] = useState<BackupJob | null>(null);
  const controller = useRef<AbortController | null>(null);
  const told = useRef(0);
  const start = useCallback((kind: BackupJob["kind"], sealed: boolean): Required<BackupRun> => {
    controller.current = new AbortController();
    told.current = 0;
    setJob({ kind, sealed, stage: kind === "backup" ? "collecting" : "opening", files: 0, filesTotal: 0, bytes: 0, bytesTotal: 0 });
    return {
      signal: controller.current.signal,
      onProgress: (progress) => {
        const now = Date.now();
        // A change of stage or a file finished is always shown; bytes in between only now and then.
        setJob((current) => {
          if (!current) return current;
          if (progress.stage === current.stage && progress.files === current.files && now - told.current < TELL_EVERY_MS) return current;
          told.current = now;
          return { ...current, ...progress };
        });
      },
    };
  }, []);
  const saving = useCallback(() => setJob((current) => current && { ...current, stage: "saving" }), []);
  const end = useCallback(() => { controller.current = null; setJob(null); }, []);
  const cancel = useCallback(() => controller.current?.abort(), []);
  // A page left while it runs stops it: nothing half-made stays behind.
  useEffect(() => () => controller.current?.abort(), []);
  return { job, start, saving, end, cancel };
}
