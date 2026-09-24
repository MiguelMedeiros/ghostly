import { providerForIssuer } from "@ghostly/browser/proofs/oidc/providers";
import { providerOf } from "../../lib/identities";
import { PROVIDER_ICONS } from "./ProviderIcons";

/** The provider's icon; for an OpenID Connect proof whose subject names a known provider, that provider's. */
function iconFor(provider: string, subject?: string) {
  const oidc = provider === "oidc" && subject ? providerForIssuer(subject)?.id : undefined;
  const key = oidc ? `oidc:${oidc}` : provider;
  return PROVIDER_ICONS[key] ? { key, ...PROVIDER_ICONS[key] } : undefined;
}

/**
 * An identity provider's mark on a tile (ProviderIcons.tsx); anything unknown gets a key (self-custodied) or
 * a badge (attested). `subject` lets an "Account at a provider" proof show Google's, Apple's… mark.
 */
export function ProviderMark({ provider, subject, small = false }: { provider: string; subject?: string; small?: boolean }) {
  const icon = iconFor(provider, subject);
  const box = small ? "h-5 w-5 rounded-md" : "h-10 w-10 rounded-xl";
  // forced-color-adjust-none: in a forced-colours (high-contrast) mode the tile keeps its colour, so a white mark stays visible.
  if (icon) return <span aria-hidden="true" data-icon={icon.key} className={`inline-flex shrink-0 items-center justify-center overflow-hidden forced-color-adjust-none ${box} ${icon.tile}`}>{icon.mark(Math.round((small ? 20 : 40) * (icon.fill ?? 0.6)))}</span>;
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

/** A small pill: "Verified" in the accent colour with a tick, a warning (expiring soon) in amber, anything else muted. */
export function StatusPill({ children, ok = false, warn = false, testId }: { children: React.ReactNode; ok?: boolean; warn?: boolean; testId?: string }) {
  const tone = ok ? "bg-accent/10 text-accent" : warn ? "bg-amber-500/15 text-amber-500" : "bg-text-muted/10 text-text-muted";
  return (
    <span data-testid={testId} className={`inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-full px-2 py-0.5 text-[11px] font-medium ${tone}`}>
      {ok && <svg aria-hidden="true" width="11" height="11" viewBox="0 0 16 16" fill="none"><path d="m3 8 3 3 7-7" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /></svg>}
      {children}
    </span>
  );
}
