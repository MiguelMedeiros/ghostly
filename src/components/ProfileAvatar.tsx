import { useState } from 'react';
import type { PublicProfile } from '@ghostly/browser/profiles/public';
import { IdentityMark, identityNames } from './IdentityMark';
export function ProfileAvatar({ profile, name }: { profile?: PublicProfile; name: string }) {
  const [failed,setFailed]=useState<string>();
  const avatar=profile?.avatar;
  const valid=avatar?.startsWith('data:image/jpeg;base64,') && avatar.length<45000;
  return <>{valid && avatar!==failed ? <img src={avatar} alt="" className="h-full w-full rounded-full object-cover" onError={()=>setFailed(avatar)} /> : <span className="text-text-muted">{name.charAt(0).toUpperCase()}</span>}{profile && <span className="absolute -bottom-1 -right-1 rounded-lg border-2 border-panel-header" role="img" aria-label={`${identityNames[profile.adapter]} public profile — self-described`}><IdentityMark kind={profile.adapter} small /></span>}</>;
}
