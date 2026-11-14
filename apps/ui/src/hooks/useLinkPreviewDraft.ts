import { useCallback, useEffect, useMemo, useState } from "react";
import { canonicalUrl, linksIn, type LinkPreview } from "@ghostly/core";
import { previewableLink } from "../lib/parse/linkPreview";
import { linkPreviewFor } from "../lib/linkPreviewFetch";

/** How long the text rests before its link is read: a link still being typed is not asked for. */
export const PREVIEW_DEBOUNCE_MS = 700;

export interface LinkPreviewDraft {
  /** The link as typed, and its canonical form (the key). */
  link: string;
  key: string;
  status: "loading" | "ready" | "none";
  preview: LinkPreview | null;
}

/**
 * The preview of the first link in a draft (WISP 401 § Link previews), made by this app once the text rests. The
 * person can remove it; a removed link gets no preview again in this draft. `preview` is what goes with the message
 * when it is sent now: only a finished preview whose link is still in the text. `kept`: the preview of the message being
 * edited; it stands for its link until a new one is made (saved at once, or the site failing now, it is not lost). It
 * reads no page, so it stays while no new one may be made (`enabled` off: previews turned off, Hide my IP on).
 */
export function useLinkPreviewDraft(text: string, enabled: boolean, kept?: LinkPreview) {
  const typed = useMemo(() => (enabled || kept ? previewableLink(text) : null), [enabled, kept, text]);
  const typedKey = typed ? canonicalUrl(typed) ?? typed : null;
  const link = enabled ? typed : null;
  const key = enabled ? typedKey : null;
  const [draft, setDraft] = useState<LinkPreviewDraft | null>(null);
  const [removed, setRemoved] = useState<ReadonlySet<string>>(() => new Set());

  useEffect(() => {
    if (!link || !key || removed.has(key)) return;
    let current = true;
    const timer = setTimeout(() => {
      setDraft({ link, key, status: "loading", preview: null });
      void linkPreviewFor(link).then(preview => {
        if (current) setDraft({ link, key, status: preview ? "ready" : "none", preview });
      });
    }, PREVIEW_DEBOUNCE_MS);
    return () => { current = false; clearTimeout(timer); };
  }, [link, key, removed]);

  const made = draft && key === draft.key && !removed.has(draft.key) ? draft : null;
  const shown: LinkPreviewDraft | null = made?.status !== "ready" && typed && typedKey && kept?.u === typedKey && !removed.has(typedKey)
    ? { link: typed, key: typedKey, status: "ready", preview: kept } : made;
  const remove = useCallback(() => {
    if (!typedKey) return;
    setRemoved(prev => new Set([...prev, typedKey]));
  }, [typedKey]);
  /** A sent message starts a new draft: what was removed may be previewed again. */
  const reset = useCallback(() => { setRemoved(new Set()); setDraft(null); }, []);
  const preview = shown?.status === "ready" && shown.preview && linksIn(text).some(l => canonicalUrl(l) === shown.preview!.u) ? shown.preview : null;
  return { draft: shown?.status === "none" ? null : shown, preview, remove, reset };
}
