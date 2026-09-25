import { providerForIssuer } from "@ghostly/browser/proofs/oidc/providers";

/**
 * One mark per identity-proof provider, keyed by the provider's id from
 * packages/browser/src/proofs/registry.ts, plus one per OpenID Connect provider
 * (`oidc:<id>`, from packages/browser/src/proofs/oidc/providers.ts). Inline SVG:
 * nothing is fetched. Every registered provider must have an entry
 * (packages/browser/test/identityProviderIcons.test.tsx checks it), so adding a
 * provider is adding its mark here; anything unknown gets ProviderMark's fallback.
 *
 * Sources and licences:
 *  - GitHub, GitLab, Apple, Twitch, Bitcoin: simple-icons 16.32 (https://simpleicons.org,
 *    CC0 1.0). Tile colours are the brand colours simple-icons lists. Each mark is
 *    shown in white on its brand colour, as the brands' guidelines allow.
 *  - Google "G" and the Microsoft four squares: drawn after the brands' sign-in
 *    guidelines (full colour on white), not recoloured. They stay their owners' trademarks.
 *  - Nostr: the community mark by bembureda (mbarulli/nostr-logo, CC0), as before.
 *  - Domain, OpenPGP, SSH and the neutral account mark: original line drawings.
 *
 * `ghostly` is not a proof provider: it is the mark of the profile's own Ghostly identity (its ID card, the
 * first of every deck), the ghost of src/assets/identities/ghostly.svg on its dark tile.
 */

export interface ProviderIcon {
  /** Tailwind classes for the tile: its background, and the mark's colour when it uses currentColor. */
  tile: string;
  /** The mark, `size` pixels square, aria-hidden by the tile around it. */
  mark: (size: number) => React.ReactElement;
  /** The mark's share of the tile (default 0.6): a slim mark can be a little larger. */
  fill?: number;
}

const stroke = { fill: "none", stroke: "currentColor", strokeWidth: 2, strokeLinecap: "round", strokeLinejoin: "round" } as const;
const svg = (size: number, viewBox: string, children: React.ReactNode, extra: React.SVGProps<SVGSVGElement> = {}) =>
  <svg width={size} height={size} viewBox={viewBox} xmlns="http://www.w3.org/2000/svg" focusable="false" {...extra}>{children}</svg>;

/** A single filled path from simple-icons (24×24 box) in the tile's text colour. */
const simple = (d: string) => (size: number) => svg(size, "0 0 24 24", <path fill="currentColor" d={d} />);

const GITHUB = "M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12";
const GITLAB = "m23.6004 9.5927-.0337-.0862L20.3.9814a.851.851 0 0 0-.3362-.405.8748.8748 0 0 0-.9997.0539.8748.8748 0 0 0-.29.4399l-2.2055 6.748H7.5375l-2.2057-6.748a.8573.8573 0 0 0-.29-.4412.8748.8748 0 0 0-.9997-.0537.8585.8585 0 0 0-.3362.4049L.4332 9.5015l-.0325.0862a6.0657 6.0657 0 0 0 2.0119 7.0105l.0113.0087.03.0213 4.976 3.7264 2.462 1.8633 1.4995 1.1321a1.0085 1.0085 0 0 0 1.2197 0l1.4995-1.1321 2.4619-1.8633 5.006-3.7489.0125-.01a6.0682 6.0682 0 0 0 2.0094-7.003z";
const APPLE = "M12.152 6.896c-.948 0-2.415-1.078-3.96-1.04-2.04.027-3.91 1.183-4.961 3.014-2.117 3.675-.546 9.103 1.519 12.09 1.013 1.454 2.208 3.09 3.792 3.039 1.52-.065 2.09-.987 3.935-.987 1.831 0 2.35.987 3.96.948 1.637-.026 2.676-1.48 3.676-2.948 1.156-1.688 1.636-3.325 1.662-3.415-.039-.013-3.182-1.221-3.22-4.857-.026-3.04 2.48-4.494 2.597-4.559-1.429-2.09-3.623-2.324-4.39-2.376-2-.156-3.675 1.09-4.61 1.09zM15.53 3.83c.843-1.012 1.4-2.427 1.245-3.83-1.207.052-2.662.805-3.532 1.818-.78.896-1.454 2.338-1.273 3.714 1.338.104 2.715-.688 3.559-1.701";
const TWITCH = "M11.571 4.714h1.715v5.143H11.57zm4.715 0H18v5.143h-1.714zM6 0L1.714 4.286v15.428h5.143V24l4.286-4.286h3.428L22.286 12V0zm14.571 11.143l-3.428 3.428h-3.429l-3 3v-3H6.857V1.714h13.714Z";
/** The ₿ of simple-icons' Bitcoin mark alone (its circle is the tile), so the letter sits at 6.1–17.5 × 2.6–17.8. */
const BITCOIN_B = "M17.288 10.291c.24-1.59-.974-2.45-2.64-3.03l.54-2.153-1.315-.33-.525 2.107c-.345-.087-.705-.167-1.064-.25l.526-2.127-1.32-.33-.54 2.165c-.285-.067-.565-.132-.84-.2l-1.815-.45-.35 1.407s.975.225.955.236c.535.136.63.486.615.766l-1.477 5.92c-.075.166-.24.406-.614.314.015.02-.96-.24-.96-.24l-.66 1.51 1.71.426.93.242-.54 2.19 1.32.327.54-2.17c.36.1.705.19 1.05.273l-.51 2.154 1.32.33.545-2.19c2.24.427 3.93.257 4.64-1.774.57-1.637-.03-2.58-1.217-3.196.854-.193 1.5-.76 1.68-1.93h.01zm-3.01 4.22c-.404 1.64-3.157.75-4.05.53l.72-2.9c.896.23 3.757.67 3.33 2.37zm.41-4.24c-.37 1.49-2.662.735-3.405.55l.654-2.64c.744.18 3.137.524 2.75 2.084v.006z";
const NOSTR = "M210.8 199.4c0 3.1-2.5 5.7-5.7 5.7h-68c-3.1 0-5.7-2.5-5.7-5.7v-15.5c.3-19 2.3-37.2 6.5-45.5 2.5-5 6.7-7.7 11.5-9.1 9.1-2.7 24.9-.9 31.7-1.2 0 0 20.4.8 20.4-10.7s-9.1-8.6-9.1-8.6c-10 .3-17.7-.4-22.6-2.4-8.3-3.3-8.6-9.2-8.6-11.2-.4-23.1-34.5-25.9-64.5-20.1-32.8 6.2.4 53.3.4 116.1v8.4c0 3.1-2.6 5.6-5.7 5.6H57.7c-3.1 0-5.7-2.5-5.7-5.7v-144c0-3.1 2.5-5.7 5.7-5.7h31.7c3.1 0 5.7 2.5 5.7 5.7 0 4.7 5.2 7.2 9 4.5 11.4-8.2 26-12.5 42.4-12.5 36.6 0 64.4 21.4 64.4 68.7v83.2ZM150 99.3c0-6.7-5.4-12.1-12.1-12.1s-12.1 5.4-12.1 12.1 5.4 12.1 12.1 12.1S150 106 150 99.3Z";

/** The Ghostly ghost (src/assets/identities/ghostly.svg, drawn in a 24-unit box), eyes cut out of its tile. */
const GHOST = "M12 2C7.582 2 4 5.582 4 10v8c0 .75.6 1 1 .6l2-1.6 2 1.6c.4.3.8.3 1.2 0L12 17l1.8 1.6c.4.3.8.3 1.2 0l2-1.6 2 1.6c.4.4 1 .15 1-.6v-8c0-4.418-3.582-8-8-8z";

const white = "text-white";
/** A white tile for the full-colour marks: a hairline keeps it from glowing on a dark theme. */
const paper = "bg-white ring-1 ring-inset ring-black/10";

const gitlab: ProviderIcon = { tile: `bg-[#fc6d26] ${white}`, mark: simple(GITLAB) };

export const PROVIDER_ICONS: Record<string, ProviderIcon> = {
  nostr: { tile: `bg-[#7138b7] ${white}`, fill: 0.7, mark: size => svg(size, "0 0 256 256", <path fill="currentColor" d={NOSTR} />) },
  domain: {
    tile: `bg-[#0e7490] ${white}`,
    mark: size => svg(size, "0 0 24 24", <g {...stroke}><circle cx="12" cy="12" r="9" /><path d="M3 12h18M12 3a13.5 13.5 0 0 1 3.5 9 13.5 13.5 0 0 1-3.5 9 13.5 13.5 0 0 1-3.5-9A13.5 13.5 0 0 1 12 3Z" /></g>),
  },
  openpgp: {
    tile: `bg-[#2f6db5] ${white}`,
    mark: size => svg(size, "0 0 24 24", <g {...stroke}><rect x="4" y="10.5" width="16" height="11" rx="2.5" /><path d="M8 10.5V7a4 4 0 0 1 8 0v3.5M12 15v2.5" /><circle cx="12" cy="14.5" r="0.5" /></g>),
  },
  bitcoin: { tile: `bg-[#f7931a] ${white}`, fill: 0.66, mark: size => svg(size, "4.2 2.6 15.2 15.2", <path fill="currentColor" fillRule="evenodd" d={BITCOIN_B} />) },
  ssh: {
    tile: `bg-[#334155] ${white}`,
    mark: size => svg(size, "0 0 24 24", <g {...stroke} strokeWidth={2.4}><path d="m5 6.5 6 5.5-6 5.5M13 18.5h6" /></g>),
  },
  "ssh-github": { tile: `bg-[#181717] ${white}`, mark: simple(GITHUB) },
  "ssh-gitlab": gitlab,
  oidc: {
    tile: `bg-[#64748b] ${white}`,
    mark: size => svg(size, "0 0 24 24", <g {...stroke}><circle cx="12" cy="12" r="9" /><circle cx="12" cy="10" r="3" /><path d="M6.5 18.5a6 6 0 0 1 11 0" /></g>),
  },
  "oidc:google": {
    tile: paper, fill: 0.55,
    mark: size => svg(size, "0 0 48 48", <>
      <path fill="#ea4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z" />
      <path fill="#4285f4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z" />
      <path fill="#fbbc05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z" />
      <path fill="#34a853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z" />
    </>),
  },
  "oidc:microsoft": {
    tile: paper, fill: 0.5,
    mark: size => svg(size, "0 0 23 23", <><rect x="0" y="0" width="11" height="11" fill="#f25022" /><rect x="12" y="0" width="11" height="11" fill="#7fba00" /><rect x="0" y="12" width="11" height="11" fill="#00a4ef" /><rect x="12" y="12" width="11" height="11" fill="#ffb900" /></>),
  },
  "oidc:apple": { tile: `bg-black ${white}`, mark: simple(APPLE) },
  "oidc:gitlab": gitlab,
  "oidc:twitch": { tile: `bg-[#9146ff] ${white}`, fill: 0.55, mark: simple(TWITCH) },
  ghostly: { tile: "bg-[#0f172a] text-[#22d3ee]", fill: 0.72, mark: size => svg(size, "0 0 24 24", <><path fill="currentColor" d={GHOST} /><circle cx="9" cy="9" r="1.5" fill="#0f172a" /><circle cx="15" cy="9" r="1.5" fill="#0f172a" /></>) },
};

/** The provider's icon; for an OpenID Connect proof whose subject names a known provider, that provider's. */
export function providerIcon(provider: string, subject?: string) {
  const oidc = provider === "oidc" && subject ? providerForIssuer(subject)?.id : undefined;
  const key = oidc ? `oidc:${oidc}` : provider;
  return PROVIDER_ICONS[key] ? { key, ...PROVIDER_ICONS[key] } : undefined;
}
