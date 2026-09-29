import { useEffect, useState, useSyncExternalStore } from 'react';
import { engine } from '@ghostly/browser/platform/engine';
import { selectedProfile } from '@ghostly/browser/profiles/public';
const subscribe = (listener: () => void) => engine.subscribe(listener);
const snapshot = () => engine.state;
export function usePublicProfiles() {
  const state = useSyncExternalStore(subscribe, snapshot);
  const [now,setNow] = useState(Date.now);
  useEffect(() => { const timer=setInterval(()=>setNow(Date.now()),1000);return()=>clearInterval(timer); },[]);
  return (peer?: string) => {
    const link=state?.links.find(l=>l.peerPubKeyZ32===peer);
    return link && selectedProfile(link.publicProfiles,link.peerProofs?.remote,link.profileChoice,link.peerParticipationKey,link.participationKey,now);
  };
}
