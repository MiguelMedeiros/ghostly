import {describe,expect,it} from 'vitest';
import {parsePaymentAmount,formatPaymentAmount,validatePaymentTarget,assertTokenUnits,assertWholeSats,ETHEREUM_USDT,SEPOLIA_TEST_USDT} from '../src/paymentIntent';
it('represents six-decimal USDT and wei exactly without floating point rounding',()=>{
 expect(parsePaymentAmount('1.000001',6)).toBe(1000001);
 expect(formatPaymentAmount(1000001,6)).toBe('1.000001');
 expect(parsePaymentAmount('0.000000000000000001',18)).toBe(1);
 expect(formatPaymentAmount('100000000000000000001',18)).toBe('100.000000000000000001');
 for(const value of ['-1','NaN','1e6','0.0000001','9007199255'])expect(()=>parsePaymentAmount(value,6)).toThrow();
});
it('binds Ethereum USDT to chain 1, the canonical contract and six decimals',()=>{
 const now=Date.now();
 const target={method:'usdt',network:'ethereum',chainId:1,asset:'USDT',unit:'token-base',token:ETHEREUM_USDT,decimals:6,address:'0x'+'1'.repeat(40),provider:'https://rpc.example',issuedAt:now,expiresAt:now+60000};
 expect(validatePaymentTarget(target)).toMatchObject({asset:'USDT',chainId:1});
 for(const override of [{chainId:31337},{asset:'TEST-USDT'},{decimals:18},{token:'0x'+'2'.repeat(40)},{issuedAt:-1},{address:'0x'+'0'.repeat(40)}])expect(()=>validatePaymentTarget({...target,...override})).toThrow();
});
it('keeps Sepolia a test network: its own chain, a test asset, never real USDT',()=>{
 const now=Date.now();
 const target={method:'usdt',network:'sepolia',chainId:11155111,asset:'TEST-USDT',unit:'token-base',token:SEPOLIA_TEST_USDT,decimals:6,address:'0x'+'1'.repeat(40),provider:'https://rpc.example',issuedAt:now,expiresAt:now+60000};
 expect(validatePaymentTarget(target)).toMatchObject({network:'sepolia',chainId:11155111,asset:'TEST-USDT'});
 for(const override of [{chainId:1},{chainId:31337},{asset:'USDT'}])expect(()=>validatePaymentTarget({...target,...override})).toThrow();
});

describe('what a contact can put in a payment target', () => {
 const now = 1_800_000_000_000;
 const ark = { method: 'arkade', network: 'bitcoin', provider: 'https://arkade.computer', asset: 'BTC', unit: 'sat', address: 'ark1qexample', expiresAt: now + 60_000 };
 it('accepts a Bitcoin target and keeps only the fields it knows', () => {
  const back = validatePaymentTarget({ ...ark, extra: 'dropped', __proto__: { polluted: true } }, now);
  expect(back).toEqual(ark);
  expect(Object.keys(back)).not.toContain('extra');
 });
 it('refuses providers a contact could use to reach something else', () => {
  for (const provider of ['http://arkade.computer', 'https://user:pass@arkade.computer', 'https://arkade.computer/?x=1', 'https://arkade.computer/#h', 'javascript:alert(1)', 'file:///etc/passwd', 'not a url'])
   expect(() => validatePaymentTarget({ ...ark, provider }, now), provider).toThrow();
  for (const provider of ['http://localhost:7070', 'http://127.0.0.1:7070', 'http://[::1]:7070']) expect(validatePaymentTarget({ ...ark, provider }, now).provider).toBe(provider);
  expect(() => validatePaymentTarget({ ...ark, provider: 'https://' + 'a'.repeat(600) + '.com' }, now)).toThrow();
 });
 it('refuses expired, far-future and malformed expiries', () => {
  for (const expiresAt of [now, now - 1, now + 24 * 60 * 60 * 1000 + 1, 1.5, Number.NaN, '1']) expect(() => validatePaymentTarget({ ...ark, expiresAt }, now), String(expiresAt)).toThrow();
 });
 it('refuses unknown methods, networks, assets and units, and empty or huge addresses', () => {
  for (const override of [{ method: 'paypal' }, { network: 'litecoin' }, { network: 'ethereum' }, { asset: 'USDT' }, { unit: 'msat' }, { address: '' }, { address: 'a'.repeat(4097) }, { address: 42 }])
   expect(() => validatePaymentTarget({ ...ark, ...override }, now), JSON.stringify(override)).toThrow();
  for (const value of [null, undefined, 'ark1', 42, []]) expect(() => validatePaymentTarget(value, now)).toThrow();
 });
 it('refuses a token request issued in the future or expiring before it was issued', () => {
  const usdt = { method: 'usdt', network: 'sepolia', provider: 'https://rpc.example', asset: 'TEST-USDT', unit: 'token-base', chainId: 11155111, token: SEPOLIA_TEST_USDT, decimals: 6, address: '0x' + '2'.repeat(40), issuedAt: now, expiresAt: now + 60_000 };
  expect(validatePaymentTarget(usdt, now)).toMatchObject({ issuedAt: now });
  for (const override of [{ issuedAt: now + 60_000 }, { issuedAt: now + 60_000, expiresAt: now + 60_000 }, { issuedAt: 1.5 }, { address: '0x123' }, { token: 'nope' }, { decimals: 19 }])
   expect(() => validatePaymentTarget({ ...usdt, ...override }, now), JSON.stringify(override)).toThrow();
 });
});

describe('amounts', () => {
 it('parses exactly, and refuses what is not a plain positive decimal', () => {
  expect(parsePaymentAmount('0.000001', 6)).toBe(1);
  expect(parsePaymentAmount('21', 0)).toBe(21);
  for (const [value, decimals] of [['1.5', 0], ['-1', 6], ['1e3', 6], ['0x10', 6], [' 1', 6], ['1.', 6], ['.5', 6], ['1', 19], ['1', -1], ['1', 1.5], ['99999999999', 6]] as const)
   expect(() => parsePaymentAmount(value, decimals), `${value}/${decimals}`).toThrow();
 });
 it('formats without floating point and drops trailing zeros', () => {
  expect(formatPaymentAmount(1_500_000, 6)).toBe('1.5');
  expect(formatPaymentAmount(1, 6)).toBe('0.000001');
  expect(formatPaymentAmount('1000000000000000000', 18)).toBe('1');
  expect(formatPaymentAmount(42)).toBe('42');
 });
 it('whole sats and token units stay positive safe integers', () => {
  for (const amount of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, Number.NaN]) {
   expect(() => assertWholeSats(amount)).toThrow();
   expect(() => assertTokenUnits(amount)).toThrow();
  }
  expect(() => assertWholeSats(2_100_000_000_000_001)).toThrow();
  expect(() => assertWholeSats(1)).not.toThrow();
 });
});
