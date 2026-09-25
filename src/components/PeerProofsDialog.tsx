import { useBackdropDismiss } from "../hooks/useDismiss";
import { QRCodeSVG } from 'qrcode.react';
import { withPubkyStorage } from '@ghostly/browser/proofs/storage';
import { currentProfileProof, selectedProfile } from '@ghostly/browser/profiles/public';
import { ProfileAvatar } from './ProfileAvatar';
import { IdentityMark, IdentityBadge, identityNames } from './IdentityMark';
import { Select } from './ui/Select';
import { useEffect, useRef, useState } from 'react';
import { nostrProofTemplate, type ProofRecord, type ProofAdapter } from '@ghostly/core';
import { engine } from '@ghostly/browser/platform/engine';
import type { LinkView } from '@ghostly/browser/shared/types';
import { importLocalSigner, disposableImportSecret, type LocalProofSigner } from '@ghostly/browser/proofs/imported';
import { extensionSigner, withNostrSigner } from '@ghostly/browser/proofs/nostr';

export function PeerProofsDialog({ link }: { link: LinkView }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const abort = useRef<AbortController | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [adding, setAdding] = useState(false);
  const [remove, setRemove] = useState<string | null>(null);
  const [adapter, setAdapter] = useState<ProofAdapter>('nostr');
  const secret = useRef<HTMLInputElement>(null);
  const localSigner = useRef<LocalProofSigner | null>(null);
  const [hasSecret, setHasSecret] = useState(false);
  const [signer, setSigner] = useState(extensionSigner() ? 'extension' : 'bunker');
  const [bunker, setBunker] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [auth, setAuth] = useState('');
  const [ringLink, setRingLink] = useState('');
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 1000); return () => { clearInterval(timer); abort.current?.abort(); localSigner.current?.clear(); }; }, []);
  const field = 'appearance-none w-full rounded-lg border border-border bg-input-bg p-2.5 text-sm text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent';
  const action = 'rounded-lg border border-border px-3 py-2 text-xs hover:bg-text-muted/10 disabled:opacity-40 focus-visible:ring-2 focus-visible:ring-accent';
  const supported = link.peerProofAdapters?.includes(adapter) ?? (adapter === 'nostr' && !!link.peerProofSupport);
  function clearSecret() { if (secret.current) secret.current.value = ''; setHasSecret(false); localSigner.current?.clear(); localSigner.current = null; }
  function close() { abort.current?.abort(); clearSecret(); setBunker(''); setAuth(''); setMessage(''); dialog.current?.close(); }
  const backdrop = useBackdropDismiss(close);
  async function share() {
    const controller = new AbortController(); abort.current = controller;
    setBusy(true); setMessage(adapter === 'nostr' ? 'Connecting to your signer…' : adapter === 'pubky-storage' ? 'Choose an identity in Pubky Ring…' : 'Preparing the local key…'); setAuth('');
    try {
      if (adapter === 'pubky-storage') {
        await withPubkyStorage({signal:controller.signal,onLink:setRingLink,onProgress:setMessage,
          prepare:externalKey=>engine.call('preparePeerProof',{linkId:link.id,externalKey,adapter:'pubky-storage'}),
          submit:(challenge,event)=>engine.call('submitPeerProof',{linkId:link.id,challenge,event})});
      } else if (adapter === 'pubky-import' || adapter === 'keet-import') {
        let input = secret.current?.value ?? '';
        if (secret.current) secret.current.value = ''; setHasSecret(false);
        const pending = importLocalSigner(adapter, input); input = '';
        const local = await pending; localSigner.current = local;
        controller.signal.throwIfAborted();
        const challenge = await engine.call('preparePeerProof', { linkId: link.id, externalKey: local.externalKey, adapter });
        controller.signal.throwIfAborted();
        const event = await local.sign(challenge);
        local.clear(); localSigner.current = null;
        controller.signal.throwIfAborted();
        await engine.call('submitPeerProof', { linkId: link.id, challenge, event });
      } else await withNostrSigner({ bunker: signer === 'bunker' ? bunker : undefined, signal: controller.signal, onAuth: setAuth }, async external => {
        const externalKey = await external.getPublicKey(); controller.signal.throwIfAborted();
        setMessage('Requesting a fresh challenge from this contact…');
        const challenge = await engine.call('preparePeerProof', { linkId: link.id, externalKey });
        controller.signal.throwIfAborted(); setMessage('Approve the exact conversation proof in your signer.');
        const event = await external.signEvent(nostrProofTemplate(challenge));
        controller.signal.throwIfAborted();
        await engine.call('submitPeerProof', { linkId: link.id, challenge, event });
      });
      setBunker(''); setAuth(''); setMessage('Identity shared. Its status is shown above.'); setAdding(false);
    } catch (e) { if (!controller.signal.aborted) setMessage(e instanceof Error ? e.message : 'Could not share proof'); }
    finally { clearSecret(); setBusy(false); abort.current = null; }
  }
  function record(r: ProofRecord, mine: boolean) {
    const expired = r.challenge.expiresAt * 1000 <= now;
    const matching = r.challenge.subject === (mine ? link.participationKey : link.peerParticipationKey) && r.challenge.audience === (mine ? link.peerParticipationKey : link.participationKey);
    const verified = matching && !expired && r.status === 'accepted';
    const status = !matching ? 'Previous key' : r.status === 'withdrawal-pending' ? 'Removing…' : r.status === 'withdrawn' ? 'No longer shared' : expired ? 'Expired' : r.status === 'pending' ? 'Awaiting contact' : r.challenge.adapter === 'pubky-storage' ? 'Pubky connected' : 'Key verified';
    const profile = !mine && verified ? link.publicProfiles?.find(p => p.adapter === r.challenge.adapter && p.key === r.challenge.externalKey && (p.name || p.avatar)) : undefined;
    return <div key={r.event.id} className="rounded-xl border border-border bg-input-bg/30 p-3">
      <div className="flex items-center gap-3"><span className="relative flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-input-bg">{profile ? <ProfileAvatar profile={profile} name={profile.name || identityNames[r.challenge.adapter]} /> : <IdentityMark kind={r.challenge.adapter} />}</span><div className="min-w-0 flex-1"><p className="truncate text-sm font-medium">{profile?.name || identityNames[r.challenge.adapter]}</p><p className="mt-0.5 text-[11px] text-text-muted">{r.challenge.adapter === 'pubky-storage' ? 'Authorized storage' : r.challenge.adapter === 'nostr' ? 'External signer' : 'Imported key · experimental'}</p></div><IdentityBadge active={verified}>{status}</IdentityBadge></div>
      <details className="mt-2 text-xs text-text-muted"><summary className="cursor-pointer rounded py-1 focus-visible:ring-2 focus-visible:ring-accent">Details</summary>
        <div className="mt-2 space-y-3 border-t border-border pt-3 leading-5">
          {!mine && <><p>{profile ? `Public profile from ${profile.source === 'nostr-signed' ? 'signed Nostr metadata' : 'the Pubky index'}. Name and photo are self-described and saved on this device.` : r.challenge.adapter === 'keet-import' ? 'No public profile lookup is available for compatible Keet keys.' : verified ? 'No public profile saved yet. Your chat name stays the same.' : 'This identity is no longer used for the chat name or photo.'}</p>{profile && <button className={action} onClick={() => void engine.call('choosePublicProfile',{linkId:link.id,choice:r.challenge.adapter}).catch(()=>setMessage('Could not change the chat profile.'))}>Use this profile in chat</button>}</>}

          <p>{r.challenge.adapter === 'pubky-storage' ? 'Your contact independently read a fresh challenge commitment from the homeserver resolved through your Pubky identity. This shows authorized storage control, not a root-key signature. The observation lasts 10 minutes, including offline or after restart. The temporary file is deleted after acknowledgement; reconnect Pubky for a fresh check. Homeserver operators and other authorized writers are part of this trust model.' : r.challenge.adapter === 'keet-import' ? 'Verifies a compatible key, not an existing Keet app account.' : r.challenge.adapter === 'pubky-import' ? 'Verifies an imported Pubky key. This is not a Pubky Ring connection.' : 'Your contact verified a signature from this Nostr key.'} This does not verify a person’s identity.</p>
          <div><p className="mb-1">Public key</p><code className="block break-all select-all rounded-lg bg-panel-header p-2 text-[11px]">{r.challenge.externalKey}</code></div>
          <p>Checked {new Date(r.verifiedAt * 1000).toLocaleString()}<br />Expires {new Date(r.challenge.expiresAt * 1000).toLocaleString()}</p>
          {mine && r.status !== 'withdrawn' && r.status !== 'withdrawal-pending' && (remove === r.event.id ? <div className="rounded-lg border border-border p-3"><p className="mb-2">Stop sharing here? Your contact may keep an existing copy.</p><div className="flex gap-2"><button className={action} disabled={busy || !link.peerProofSupport} onClick={async () => {
            try { await engine.call('withdrawPeerProof', { linkId: link.id, adapter: r.challenge.adapter }); setRemove(null); setMessage('Removal sent to this contact.'); }
            catch { setMessage('Could not remove this identity. Reconnect and try again.'); }
          }}>Stop sharing</button><button className={action} onClick={() => setRemove(null)}>Keep it</button></div></div> : <button className={action} onClick={() => setRemove(r.event.id)}>Stop sharing here</button>)}
        </div>
      </details>
    </div>;
  }
  const byStatus = (records: ProofRecord[]) => [...records].sort((a,b) => Number(b.status === 'accepted' && b.challenge.expiresAt * 1000 > now) - Number(a.status === 'accepted' && a.challenge.expiresAt * 1000 > now));
  const local = byStatus(link.peerProofs?.local ?? []);
  const remote = byStatus(link.peerProofs?.remote ?? []);
  return <>
    <button className="flex h-7 max-w-full items-center gap-2 rounded-lg text-xs text-text-muted transition-colors hover:text-text-primary focus-visible:ring-2 focus-visible:ring-accent" onClick={() => { setAdding(false); setMessage(''); dialog.current?.showModal(); }} aria-label="Identities for this conversation">
      <IdentityMark kind="ghostly" small /><span>Identities</span><span className="flex items-center gap-1" aria-hidden="true">{Array.from(new Set(remote.filter(r => r.status === 'accepted' && r.challenge.expiresAt * 1000 > now).map(r => r.challenge.adapter))).map(a => <IdentityMark kind={a} key={a} small />)}</span><span aria-hidden="true">›</span>
    </button>
    <dialog ref={dialog} {...backdrop} aria-labelledby={`proof-title-${link.id}`} onCancel={close} className="m-auto max-h-[90dvh] w-[min(34rem,calc(100%-2rem))] overflow-y-auto rounded-2xl border border-border bg-panel-header p-5 text-text-primary shadow-2xl backdrop:bg-black/60">
      <div className="flex items-center justify-between gap-4"><div><h2 id={`proof-title-${link.id}`} className="text-lg font-semibold">Identities</h2><p className="mt-1 text-xs text-text-muted">Only for this conversation</p></div><button autoFocus aria-label="Close identities" className={`${action} text-lg`} onClick={close}>×</button></div>
      <div className="mt-5 rounded-xl border border-accent/20 bg-accent/5 p-4"><div className="flex items-center gap-3"><IdentityMark kind="ghostly" /><div className="flex-1"><h3 className="text-sm font-semibold">You’re already Ghostly</h3><p className="mt-1 text-xs text-text-muted">Everything you need to chat.</p></div><IdentityBadge active>Default</IdentityBadge></div>
        <details className="mt-2 text-xs text-text-muted"><summary className="cursor-pointer rounded py-1 focus-visible:ring-2 focus-visible:ring-accent">Connection identity</summary><p className="mt-2 leading-5">These keys secure this conversation. Extra identities never replace them.</p><p className="mt-2">You</p><code className="block break-all select-all text-[11px]">{link.participationKey}</code><p className="mt-2">Contact</p><code className="block break-all select-all text-[11px]">{link.peerParticipationKey ?? 'Confirm your contact first'}</code></details>
      </div>
      {remote.length > 0 && <section className="mt-5"><h3 className="mb-2 text-xs font-medium text-text-muted">Shared by your contact</h3><div className="space-y-2">{remote.map(r => record(r, false))}</div></section>}
      {local.length > 0 && <section className="mt-5"><h3 className="mb-2 text-xs font-medium text-text-muted">Shared by you</h3><div className="space-y-2">{local.map(r => record(r, true))}</div></section>}
      {remote.length > 0 && <details className="mt-4 rounded-xl border border-border p-3 text-xs text-text-muted"><summary className="cursor-pointer font-medium focus-visible:ring-2 focus-visible:ring-accent">Name & photo in this chat</summary><div className="mt-3 space-y-3 leading-5"><p>{link.label ? 'Your nickname is kept. A profile can add a photo.' : 'Use a public profile shared by this contact, or keep their Ghostly name.'}</p><label className="block">Show<span className="mt-1 block"><Select aria-label="Chat profile" value={link.profileChoice ?? 'auto'} onChange={choice => void engine.call('choosePublicProfile',{linkId:link.id,choice}).catch(()=>setMessage('Could not change the chat profile.'))} options={[{value:'auto' as const,label:'Public profile when available'},{value:'ghostly' as const,label:'Ghostly name / my nickname'},...remote.filter(r => currentProfileProof(r,link.peerParticipationKey,link.participationKey,now)).map(r => ({value:r.challenge.adapter,label:identityNames[r.challenge.adapter],icon:<IdentityMark kind={r.challenge.adapter} small />}))]} /></span></label><p>{selectedProfile(link.publicProfiles,remote,link.profileChoice,link.peerParticipationKey,link.participationKey,now)?.name ?? 'No public name selected.'} Profiles disappear from the chat when their proof expires or is removed.</p><button className={action} disabled={refreshing || link.profileChoice === 'ghostly'} onClick={async () => {setRefreshing(true);try {await engine.call('refreshPublicProfiles',{linkId:link.id,force:true});setMessage('Profile check complete. Saved profiles remain available offline.');} catch {setMessage('Profiles unavailable. Your chat is unaffected.');}finally{setRefreshing(false);}}}>{refreshing ? 'Checking…' : 'Check public profiles'}</button><p className="text-[11px]">Reads only the presented public key. Cached locally; checks are rate-limited. Nostr metadata is signed. Pubky metadata comes from its public index. Photos use supported public hosts.</p></div></details>}
      <section className="mt-5 border-t border-border pt-4">
        {!adding ? <><button className="flex w-full items-center justify-between rounded-xl border border-border p-3 text-left text-sm transition-colors hover:bg-accent/5 focus-visible:ring-2 focus-visible:ring-accent" onClick={() => { setAdding(true); setMessage(''); }}><span><span className="block font-medium">Add an identity</span><span className="mt-1 block text-xs text-text-muted">Optional. Choose what this contact sees.</span></span><span aria-hidden="true" className="text-xl text-accent">+</span></button>{!local.length && !remote.length && <p className="mt-3 text-center text-xs text-text-muted">No extra identities shared yet.</p>}</> : <>
          <div className="mb-3 flex items-center justify-between"><h3 className="text-sm font-medium">Share an identity</h3><button className="rounded px-2 py-1 text-xs text-text-muted focus-visible:ring-2 focus-visible:ring-accent" disabled={busy} onClick={() => { clearSecret(); setAdding(false); setMessage(''); }}>Back</button></div>
          <div className="grid grid-cols-3 gap-2" aria-label="Choose identity">{(['nostr','pubky-storage','keet-import'] as const).map(a => <button key={a} aria-pressed={adapter === a || (a === 'pubky-storage' && adapter === 'pubky-import')} disabled={busy} onClick={() => { clearSecret(); setBunker(''); setMessage(''); setAdapter(a); }} className={`flex flex-col items-center gap-2 rounded-xl border p-3 text-xs focus-visible:ring-2 focus-visible:ring-accent ${adapter === a ? 'border-accent bg-accent/5 text-text-primary' : 'border-border text-text-muted hover:bg-text-muted/5'}`}><IdentityMark kind={a} /><span>{identityNames[a]}</span></button>)}</div>
          <div className="mt-4 space-y-3">
            {(adapter === 'pubky-storage' || adapter === 'pubky-import') && <label className="block text-xs">Connect with<span className="mt-1 block"><Select aria-label="Pubky connection" value={adapter} disabled={busy} onChange={next=>{clearSecret();setAdapter(next);setMessage('');}} options={[{value:'pubky-storage' as const,label:'Pubky Ring',description:'Official app'},{value:'pubky-import' as const,label:'Local import',description:'Advanced'}]} /></span></label>}
            {adapter === 'pubky-storage' ? <><p className="text-xs leading-5 text-text-muted">Scan with the official Pubky Ring app and authorize a temporary Ghostly folder. Your contact checks it independently.</p>{ringLink && <div className="space-y-3 rounded-xl border border-border p-3"><div className="mx-auto w-fit rounded-lg bg-white p-3"><QRCodeSVG value={ringLink} size={224} /></div><button className={action} onClick={()=>void navigator.clipboard.writeText(ringLink)}>Copy Ring authorization link</button><p className="text-xs text-text-muted">Keep this QR private. Approval expires here in 3 minutes.</p></div>}</> : adapter === 'nostr' ? <>
              <p className="text-xs text-text-muted">Approve in your Nostr signer. Your secret stays there.</p>
              <label className="block text-xs">Sign with<span className="mt-1 block"><Select aria-label="Nostr signer" value={signer} disabled={busy} onChange={setSigner} options={[{value:'bunker',label:'Remote signer'},{value:'extension',label:'Browser extension',description:extensionSigner() ? undefined : 'Not available',disabled:!extensionSigner()}]} /></span></label>
              {signer === 'bunker' && <label className="block text-xs">Signer connection link<input aria-label="Signer connection link" type="password" autoComplete="off" spellCheck={false} className={`${field} mt-1`} value={bunker} disabled={busy} onChange={e => setBunker(e.target.value)} placeholder="bunker://…" /></label>}
            </> : <>
              <div className="flex items-center gap-2"><IdentityBadge>Local import</IdentityBadge><IdentityBadge>Experimental</IdentityBadge></div>
              <p className="text-xs leading-5 text-text-muted">You’re giving Ghostly a secret to sign locally. It isn’t saved or sent to your contact.</p>
              {adapter === 'keet-import' && <p className="text-xs text-text-muted">Shows a compatible key, not a Keet app account.</p>}
              <label className="block text-xs">{adapter === 'pubky-import' ? 'Pubky secret key' : 'Keet recovery phrase'}<input key={adapter} ref={secret} type="password" aria-label="Local import secret" autoComplete="off" autoCorrect="off" autoCapitalize="none" spellCheck={false} maxLength={512} className={`${field} mt-1`} disabled={busy} onInput={e => setHasSecret(!!e.currentTarget.value)} placeholder={adapter === 'pubky-import' ? '64 hex characters' : '24 English words'} /></label>
            </>}
            <p className="text-xs leading-5 text-text-muted">Sharing the same identity elsewhere can link your conversations.</p>
            {!supported && <p role="status" className="rounded-lg bg-text-muted/10 p-2 text-xs text-text-muted">Connect to this contact to share this identity.</p>}
            <div className="flex gap-2"><button className="min-h-10 flex-1 rounded-xl bg-accent px-4 py-2 text-sm font-medium text-on-accent disabled:opacity-40 focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-panel-header" disabled={busy || !supported || (adapter === 'pubky-storage' ? false : adapter === 'nostr' ? signer === 'bunker' && !bunker : !hasSecret)} onClick={() => void share()}>{busy ? 'Waiting for approval…' : adapter === 'pubky-storage' ? 'Connect Pubky' : 'Share with this contact'}</button>{busy && <button className={action} onClick={() => { abort.current?.abort(); clearSecret(); setMessage('Cancelled. Nothing else will be sent.'); }}>Cancel</button>}</div>
            {auth && <a href={auth} target="_blank" rel="noreferrer" className="block rounded text-xs text-accent underline">Open signer approval</a>}
            <details className="text-xs text-text-muted"><summary className="cursor-pointer rounded py-1 focus-visible:ring-2 focus-visible:ring-accent">How it works</summary><div className="mt-2 space-y-3 leading-5"><p>Extra identities are optional and bound to this conversation. They do not verify a person’s identity.</p><p>{adapter === 'pubky-storage' ? 'Official Ring authorizes write access only to a random Ghostly proof folder. A temporary public file contains a commitment and expiry, never chat content or participant keys. Your contact resolves your homeserver itself. Session credentials stay on this device. Ghostly deletes the file and signs out after the check; interruption or network failure can leave a file or session behind. The observation still expires, and a new check needs a new challenge.' : adapter === 'nostr' ? 'Supports NIP-07 browser extensions and NIP-46 remote signers. Use a connection link supplied by your signer.' : adapter === 'pubky-import' ? 'Accepts a 32-byte hex secret. This does not connect to Pubky Ring.' : 'Accepts a 24-word English mnemonic without an extra passphrase. It does not connect to the Keet app.'}</p>{(adapter === 'pubky-import' || adapter === 'keet-import') && <><p>The field and signing buffers are cleared after use or cancellation. JavaScript and SDK memory cannot guarantee perfect erasure.</p><button className={action} disabled={busy} onClick={async () => {
              const controller = new AbortController(); abort.current = controller; setBusy(true); setMessage('');
              try { const value = await disposableImportSecret(adapter); if (!controller.signal.aborted && secret.current) { secret.current.value = value; setHasSecret(true); setMessage('Test key ready. Nothing shared yet.'); } }
              catch { if (!controller.signal.aborted) setMessage('Could not generate a test key.'); }
              finally { setBusy(false); abort.current = null; }
            }}>Try with a disposable test key</button></>}</div></details>
          </div>
        </>}
      </section>
      {(message || link.proofError) && <p role="status" className="mt-3 rounded-lg bg-text-muted/5 p-3 text-xs leading-5 text-text-muted">{message || 'Something went wrong. Reconnect and try again.'}</p>}
    </dialog>
  </>;
}
