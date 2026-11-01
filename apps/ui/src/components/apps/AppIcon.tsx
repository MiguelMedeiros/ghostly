import { useEffect, useState } from "react";
import { installedIconUrl } from "../../lib/apps/icons";

/** The generic mark of an app: what a card shows before anything is checked, and an app without an icon. */
export function AppGlyph({ size = 20 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="3.5" y="3.5" width="7" height="7" rx="1.6" />
      <rect x="13.5" y="3.5" width="7" height="7" rx="1.6" />
      <rect x="3.5" y="13.5" width="7" height="7" rx="1.6" />
      <path d="M17 13.5v7M13.5 17h7" />
    </svg>
  );
}

/** A picture of bytes on this device (a preview's `icon.png`), for as long as it shows. */
function useBytesUrl(bytes: Uint8Array | null | undefined): string | null {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!bytes?.length) { setUrl(null); return; }
    const next = URL.createObjectURL(new Blob([bytes as BlobPart], { type: "image/png" }));
    setUrl(next);
    return () => URL.revokeObjectURL(next);
  }, [bytes]);
  return url;
}

/**
 * An app's icon: from the checked bundle only (its `icon.png`, read on this device with `appFile`, or the preview's),
 * never from a store or a card, so nobody can dress an app in someone else's picture. The generic mark otherwise.
 */
export function AppIcon({ size = 40, icon, installed }: { size?: number; icon?: Uint8Array | null; installed?: { ref: string; digest: string; icon: boolean } }) {
  const [read, setRead] = useState<string | null>(null);
  const ref = installed?.icon ? installed.ref : null;
  const digest = installed?.digest;
  useEffect(() => {
    if (!ref || !digest) { setRead(null); return; }
    let live = true;
    installedIconUrl(ref, digest).then((url) => { if (live) setRead(url); }, () => {});
    return () => { live = false; };
  }, [ref, digest]);
  const shown = useBytesUrl(icon);
  const url = icon ? shown : read;
  return (
    <span className="shrink-0 grid place-items-center overflow-hidden rounded-xl bg-accent/15 text-accent" style={{ width: size, height: size }} data-testid="app-icon">
      {url ? <img src={url} alt="" draggable={false} className="w-full h-full object-cover" /> : <AppGlyph size={Math.round(size * 0.5)} />}
    </span>
  );
}

/** A publisher's fingerprint (80 bits in four groups), as people compare it. */
export function Fingerprint({ value }: { value: string }) {
  return <span dir="ltr" className="font-mono text-[11px] text-text-secondary tracking-wide">{value}</span>;
}
