import { useEffect, useRef, useState, type ClipboardEvent, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import { useI18n } from "../../contexts/I18nContext";
import { useBackdropDismiss, useDialogFocus } from "../../hooks/useDismiss";
import { decodablePicture } from "../../lib/decodablePicture";
import { formatFileSize } from "../../lib/format";
import { DocumentGlyph } from "./icons";
import { useComposition } from "../../hooks/useComposition";

/**
 * A picture for each image among `files` (while the sheet is open), by position: only one whose own bytes say a size
 * the chat would draw (`decodablePicture`). Any other shows its name and size, and is sent as it is.
 */
function usePictures(files: File[]): (string | undefined)[] {
  const [drawable, setDrawable] = useState<ReadonlyMap<File, boolean>>(new Map());
  const asked = useRef(new WeakSet<File>());
  useEffect(() => {
    for (const file of files) {
      if (!file.type.startsWith("image/") || asked.current.has(file)) continue;
      asked.current.add(file);
      void decodablePicture(file).then((yes) => setDrawable((was) => new Map(was).set(file, yes)));
    }
  }, [files]);
  const [urls, setUrls] = useState<(string | undefined)[]>([]);
  useEffect(() => {
    const made = files.map((file) => drawable.get(file) ? URL.createObjectURL(file) : undefined);
    setUrls(made);
    return () => made.forEach((url) => url && URL.revokeObjectURL(url));
  }, [files, drawable]);
  return urls;
}

/**
 * Files pasted or dropped into a chat, before they go: the picture (or the name and size of a
 * file), a caption, Send and Cancel. Another paste adds to them; each can be taken out.
 */
export function AttachmentSheet({ files, alert, status, returnFocus, onPaste, onRemove, onSend, onCancel }: {
  files: File[];
  /** The message field: the focus goes there on close when nothing had it as the sheet opened (a share, a paste on the page). */
  returnFocus?: RefObject<HTMLElement | null>;
  /** What the composer has to say meanwhile (a paste that could not be read): here, where it is seen and announced. */
  alert?: ReactNode;
  /** What the composer is doing meanwhile (another paste being read). */
  status?: ReactNode;
  /** A paste anywhere on the sheet, the caption included: true when it was taken as files (text stays the caption's). */
  onPaste: (data: DataTransfer | null) => boolean;
  onRemove: (index: number) => void;
  /** The caption, trimmed ("" for none). */
  onSend: (caption: string) => void;
  onCancel: () => void;
}) {
  const { t } = useI18n();
  const ref = useRef<HTMLDivElement>(null);
  const [caption, setCaption] = useState("");
  const [broken, setBroken] = useState<ReadonlySet<File>>(new Set());
  const pictures = usePictures(files);
  const backdrop = useBackdropDismiss(onCancel);
  useDialogFocus(ref, onCancel, undefined, returnFocus);
  // After the dialog has noted what had the focus (the message field gets it back on close): typing goes to the caption.
  const captionRef = useRef<HTMLInputElement>(null);
  const composition = useComposition();
  useEffect(() => captionRef.current?.focus(), []);

  const send = () => onSend(caption.trim());
  const paste = (e: ClipboardEvent) => {
    if (onPaste(e.clipboardData)) e.preventDefault();
  };
  // The × that has the focus goes with its file when it is the last one (the rows are kept by place), and every ×
  // goes once one file is left: the focus moves first, to the × before it, or to the caption, not to the page.
  const removers = useRef<(HTMLButtonElement | null)[]>([]);
  const remove = (i: number) => {
    if (document.activeElement === removers.current[i]) {
      if (files.length === 2) captionRef.current?.focus();
      else if (i === files.length - 1) removers.current[i - 1]?.focus();
    }
    onRemove(i);
  };
  const picture = (i: number) => broken.has(files[i]) ? undefined : pictures[i];
  const lost = (file: File) => setBroken((was) => new Set(was).add(file));
  const single = files.length === 1 ? files[0] : null;
  const button = "min-h-10 px-4 rounded-full text-sm font-medium cursor-pointer";

  return createPortal(
    <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/70 p-4 animate-fade-in" {...backdrop}>
      <div ref={ref} tabIndex={-1} role="dialog" aria-modal="true" aria-label={t("composer.sendFiles")} data-testid="attachment-sheet"
        onPaste={paste} className="focus:outline-none w-full max-w-md max-h-full flex flex-col bg-panel-header border border-border rounded-2xl shadow-2xl overflow-hidden">
        {single && picture(0) ? (
          <figure className="m-0 flex flex-col min-h-0">
            <div className="bg-black/40 flex items-center justify-center min-h-0">
              <img src={picture(0)} alt={single.name} onError={() => lost(single)} data-testid="attachment-image" className="max-w-full max-h-[55vh] object-contain" />
            </div>
            {/* The name is cut in its own direction, at its end, as in the file rows; the size stays whole beside it. */}
            <figcaption className="px-4 pt-2 text-xs text-text-muted flex min-w-0" data-testid="attachment-name">
              <span dir="auto" className="min-w-0 truncate">{single.name}</span>
              <span className="shrink-0 whitespace-pre"> · {formatFileSize(single.size)}</span>
            </figcaption>
          </figure>
        ) : (
          <ul className={`list-none m-0 p-3 overflow-y-auto min-h-0 grid gap-2 ${single ? "grid-cols-1" : "grid-cols-3"}`} data-testid="attachment-list">
            {files.map((file, i) => (
              <li key={i} data-testid="attachment-item" className={`relative rounded-lg border border-border bg-surface-alt overflow-hidden ${single ? "flex items-center gap-3 p-3" : "aspect-square"}`}>
                {picture(i) ? <img src={picture(i)} alt={file.name} onError={() => lost(file)} className="w-full h-full object-cover" />
                  : <div className={`${single ? "flex items-center gap-3 min-w-0" : "h-full flex flex-col items-center justify-center gap-1 p-2 text-center"} text-text-secondary`}>
                    <span className="shrink-0" aria-hidden="true"><DocumentGlyph /></span>
                    <span className={`min-w-0 ${single ? "" : "w-full"}`}>
                      <span dir="auto" className="block text-xs text-text-primary truncate">{file.name}</span>
                      <span className="block text-[11px] text-text-muted">{formatFileSize(file.size)}</span>
                    </span>
                  </div>}
                {files.length > 1 && (
                  <button type="button" ref={(element) => { removers.current[i] = element; }} onClick={() => remove(i)} aria-label={t("composer.removeFile", { name: file.name })} title={t("composer.removeFile", { name: file.name })}
                    className="absolute top-1 end-1 w-7 h-7 rounded-full bg-black/60 text-white flex items-center justify-center cursor-pointer">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12" /></svg>
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
        <div className="p-3 flex flex-col gap-3 shrink-0">
          {status}
          {alert && <div role="alert" className="animate-fade-in">{alert}</div>}
          <input ref={captionRef} type="text" value={caption} onChange={(e) => setCaption(e.target.value)} data-testid="attachment-caption"
            {...composition.inputProps} onKeyDown={(e) => { if (composition.composing(e)) return; if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); } }}
            placeholder={t("composer.caption")} aria-label={t("composer.caption")} maxLength={4000}
            className="w-full min-h-10 px-3 rounded-lg bg-surface-alt border border-border text-sm text-text-primary placeholder:text-text-muted focus:outline-none focus:border-accent" />
          <div className="flex items-center justify-end gap-2">
            <button type="button" data-testid="attachment-cancel" onClick={onCancel} className={`${button} bg-surface-alt text-text-primary border border-border`}>{t("common.cancel")}</button>
            <button type="button" data-testid="attachment-send" onClick={send} className={`${button} bg-accent text-on-accent hover:bg-accent-hover`}>
              {files.length > 1 ? t("composer.sendCount", { count: String(files.length) }) : t("composer.send")}
            </button>
          </div>
        </div>
      </div>
    </div>, document.body);
}
