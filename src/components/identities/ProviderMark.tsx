import nostr from "../../assets/identities/nostr.svg";
import { providerOf } from "../../lib/identities";

const LOGOS: Record<string, { src: string; bg: string }> = { nostr: { src: nostr, bg: "bg-[#7138b7]" } };

/** An identity provider's mark: its logo when bundled, otherwise a key (self-custodied) or a badge (attested). */
export function ProviderMark({ provider, small = false }: { provider: string; small?: boolean }) {
  const logo = LOGOS[provider];
  const box = small ? "h-5 w-5 rounded-md" : "h-10 w-10 rounded-xl";
  if (logo) return <span aria-hidden="true" className={`inline-flex shrink-0 items-center justify-center overflow-hidden ${box} ${logo.bg}`}><img src={logo.src} alt="" className={small ? "h-4 w-4 object-contain" : "h-7 w-7 object-contain"} /></span>;
  const attested = providerOf(provider)?.category === "provider-attested";
  return (
    <span aria-hidden="true" className={`inline-flex shrink-0 items-center justify-center ${box} bg-surface-alt text-text-secondary border border-border`}>
      <svg width={small ? 12 : 20} height={small ? 12 : 20} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        {attested ? <><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10Z" /><path d="m9 12 2 2 4-4" /></>
          : <><circle cx="7.5" cy="15.5" r="5.5" /><path d="m21 2-9.6 9.6M15.5 7.5l3 3L22 7l-3-3" /></>}
      </svg>
    </span>
  );
}

/** A small pill: "Verified" in the accent colour with a tick, anything else muted. */
export function StatusPill({ children, ok = false, testId }: { children: React.ReactNode; ok?: boolean; testId?: string }) {
  return (
    <span data-testid={testId} className={`inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-full px-2 py-0.5 text-[11px] font-medium ${ok ? "bg-accent/10 text-accent" : "bg-text-muted/10 text-text-muted"}`}>
      {ok && <svg aria-hidden="true" width="11" height="11" viewBox="0 0 16 16" fill="none"><path d="m3 8 3 3 7-7" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /></svg>}
      {children}
    </span>
  );
}
