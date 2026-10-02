import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { useI18n } from "../contexts/I18nContext";
import { useIsMobile } from "../hooks/useIsMobile";
import type { BackupJob } from "../hooks/useBackupJob";
import { byteSize } from "../lib/backupFile";
import { Button } from "./wallet/ui";

/**
 * The progress of a backup or restore: what is being done, how many files and bytes are through, and Cancel. A dialog
 * in the middle of the window; on a phone a sheet from the bottom, like the app's other sheets. It takes the window
 * (nothing else should change the profile meanwhile) but the bar keeps moving: the work never blocks the page.
 */
export function BackupProgress({ job, onCancel }: { job: BackupJob; onCancel: () => void }) {
  const { t } = useI18n();
  const phone = useIsMobile();
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => { ref.current?.focus({ preventScroll: true }); }, []);
  const moving = job.bytesTotal > 0 && (job.stage === "writing" || job.stage === "restoring");
  const percent = job.stage === "saving" || job.stage === "verifying" ? 100 : moving ? Math.min(100, Math.floor((job.bytes / job.bytesTotal) * 100)) : null;
  const stage = job.stage === "writing" && !job.sealed ? t("profile.backups.progress.stage.writingPlain") : t(`profile.backups.progress.stage.${job.stage}`);
  const title = job.kind === "backup" ? t("profile.backups.progress.backingUp") : t("profile.backups.progress.restoring");
  // The file being worked on is the one after those already through.
  const fileNow = Math.min(job.filesTotal, job.files + (moving && job.files < job.filesTotal ? 1 : 0));
  return createPortal(<>
    <div aria-hidden="true" className="fixed inset-0 z-50 bg-black/50 animate-fade-in" />
    <div ref={ref} tabIndex={-1} role="dialog" aria-modal="true" aria-labelledby="backup-progress-title" data-testid="backup-progress" data-stage={job.stage} data-side={phone ? "bottom" : "center"}
      className={`fixed z-50 bg-panel-header border-border shadow-2xl outline-none space-y-3 ${phone
        ? "inset-x-0 bottom-0 rounded-t-2xl border-t px-4 pt-5 pb-4 pb-safe"
        : "left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 w-[min(26rem,calc(100vw-2rem))] rounded-2xl border p-5"}`}>
      {phone && <div aria-hidden="true" className="absolute top-1.5 inset-x-0 mx-auto h-1 w-9 rounded-full bg-border-bright" />}
      <h2 id="backup-progress-title" className="m-0 text-base font-semibold text-text-primary">{title}</h2>
      <p data-testid="backup-progress-stage" aria-live="polite" className="text-sm text-text-secondary">{stage}</p>
      <div role="progressbar" aria-label={title} aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent ?? undefined} data-testid="backup-progress-bar"
        className="h-2 w-full overflow-hidden rounded-full bg-surface-alt">
        <div className={`h-full rounded-full bg-accent ${percent === null ? "w-1/3 animate-pulse" : "transition-[width] duration-150"}`} style={percent === null ? undefined : { width: `${percent}%` }} />
      </div>
      <div className="flex flex-wrap justify-between gap-x-4 gap-y-1 text-xs text-text-muted min-h-4">
        <span data-testid="backup-progress-files">{job.filesTotal > 0 ? t("profile.backups.progress.files", { done: fileNow, total: job.filesTotal }) : ""}</span>
        <span data-testid="backup-progress-bytes">{job.bytesTotal > 0 ? t("profile.backups.progress.bytes", { done: byteSize(job.bytes), total: byteSize(job.bytesTotal) }) : ""}</span>
      </div>
      <div className="flex justify-end min-h-10">
        {job.stage !== "saving" && <Button data-testid="backup-progress-cancel" onClick={onCancel}>{t("common.cancel")}</Button>}
      </div>
    </div>
  </>, document.body);
}
