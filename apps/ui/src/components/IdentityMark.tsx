import ghostly from '../assets/identities/ghostly.svg';
import nostr from '../assets/identities/nostr.svg';
import pubky from '../assets/identities/pubky.svg';
import keet from '../assets/identities/keet.svg';
import type { ProofAdapter } from '@ghostly/core';
export type IdentityKind = ProofAdapter | 'ghostly';
// eslint-disable-next-line react-refresh/only-export-components -- Shared labels for these identity marks.
export const identityNames: Record<IdentityKind, string> = { ghostly: 'Ghostly', nostr: 'Nostr', 'pubky-import': 'Pubky', 'pubky-ring': 'Pubky (legacy)', 'pubky-storage': 'Pubky', 'keet-import': 'Keet' };
const marks = { ghostly, nostr, 'pubky-import': pubky, 'pubky-ring': pubky, 'pubky-storage': pubky, 'keet-import': keet };
export function IdentityMark({ kind, small = false }: { kind: IdentityKind; small?: boolean }) {
  return <span aria-hidden="true" className={`inline-flex shrink-0 items-center justify-center overflow-hidden rounded-xl ${small ? 'h-5 w-5 rounded-md' : 'h-10 w-10'} ${kind === 'nostr' ? 'bg-[#7138b7]' : kind === 'pubky-import' ? 'bg-[#171b20]' : 'bg-[#0f172a]'}`}><img src={marks[kind]} alt="" className={small ? 'h-4 w-4 object-contain' : 'h-7 w-7 object-contain'} /></span>;
}
export function IdentityBadge({ children, active = false }: { children: React.ReactNode; active?: boolean }) {
  return <span className={`inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium ${active ? 'bg-accent/10 text-accent' : 'bg-text-muted/10 text-text-muted'}`}>{active && <svg aria-hidden="true" width="11" height="11" viewBox="0 0 16 16" fill="none"><path d="m3 8 3 3 7-7" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /></svg>}{children}</span>;
}
