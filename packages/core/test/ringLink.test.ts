import {createRingInputRouter} from '../src/ringInput';
import {describe,it,expect,vi} from 'vitest';
import {createIdentity} from '../src/identity';
import {createRingLink,isRingLink,parseRingLink} from '../src/ringLink';
const now=1800000000,delegate=createIdentity().pubKeyZ32,secret=crypto.getRandomValues(new Uint8Array(32));
const request=createRingLink(secret,delegate,now+180);
describe('Ghostly request generated for actual Ring parser',()=>{
 it('uses isolated scheme and round-trips QR/deeplink/clipboard through the same parser used in Ring',()=>{expect(request.startsWith('ghostlyring://proof?')).toBe(true);for(const value of [request,' \n'+request+'\n ',encodeURIComponent(request),request.replace('proof?','proof/?'),request.replace('ghostlyring://proof','pubkyring://ghostly-proof')]){expect(isRingLink(value)).toBe(true);const parsed=parseRingLink(value,now);expect(parsed.secret).toEqual(secret);expect(parsed.delegate).toBe(delegate);expect(parsed.expires).toBe(now+180);}});
 it.each(['&secret=other','&v=1','&relay=https%3A%2F%2Fexample.com','#fragment','&extra=x'])('rejects unexpected/duplicate parameters instead of falling back to import: %s',suffix=>{expect(isRingLink(request+suffix)).toBe(true);expect(()=>parseRingLink(request+suffix,now)).toThrow(/Invalid/);});
 it('recognizes malformed own-format requests but returns actionable, secret-free errors',()=>{for(const input of ['ghostlyring://wrong?secret=private','ghostlyring://proof?v=1&secret=%','pubkyring://ghostly-proof?bad=private',request.replace('v=1','v=2'),request.replace(delegate,'bad')]){expect(isRingLink(input)).toBe(true);expect(()=>parseRingLink(input,now)).toThrow('Invalid Ring request. Copy a new connection link from Ghostly.');}});
 it('rejects expired or excessively future requests',()=>{expect(()=>parseRingLink(request,now+181)).toThrow(/expired/);expect(()=>parseRingLink(request,now-31)).toThrow(/expired/);});
 it('does not intercept regular Ring auth/import/session routes or arbitrary content',()=>{for(const value of ['pubkyring://session?x-success=x','pubkyauth:///?secret=x','pubkyring://ghostly-proofing?x=1','https://example.com',secret.toString(),undefined])expect(isRingLink(value)).toBe(false);});
});

// The actual dispatcher imported by App, all three scanners and SelectPubky.
describe('modified Ring input dispatch',()=>{
 it('intercepts generated input before generic parser on deeplink, QR and paste',()=>{const router=createRingInputRouter(),seen:string[]=[];const close=router.subscribe(url=>{parseRingLink(url,now);seen.push('approval');});const generic=vi.fn();for(const input of [request,encodeURIComponent(request),'  '+request+'  ']){if(!router.open(input))generic();}expect(seen).toHaveLength(3);expect(generic).not.toHaveBeenCalled();close();});
 it('queues only in memory before consent UI mounts, then expires without action',()=>{vi.useFakeTimers();try{const router=createRingInputRouter(),seen=vi.fn();expect(router.open(request)).toBe(true);vi.advanceTimersByTime(180001);const close=router.subscribe(seen);expect(seen).not.toHaveBeenCalled();close();}finally{vi.useRealTimers();}});
 it('delivers pre-mount input once and routes invalid own links to a useful error, never key import',()=>{const router=createRingInputRouter(),seen=vi.fn();router.open(request);const close=router.subscribe(seen);expect(seen).toHaveBeenCalledTimes(1);close();const errors:string[]=[];const stop=router.subscribe(url=>{try{parseRingLink(url,now);}catch(e){errors.push((e as Error).message);}});expect(router.open('ghostlyring://proof?secret=bad')).toBe(true);expect(errors).toEqual(['Invalid Ring request. Copy a new connection link from Ghostly.']);stop();});
});
