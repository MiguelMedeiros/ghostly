import { C as sha3_512, O as wrapConstructor, S as sha3_256, _ as sha224, b as sha384, f as createHasher, g as rotl, i as Maj, r as HashMD, t as Chi$1, u as clean, v as sha256, w as sha512 } from "./sha512-BYId-G-T.js";
//#region ../../node_modules/openpgp/dist/lightweight/noble_hashes.mjs
/*! OpenPGP.js v6.3.2 - 2026-09-24 - this is LGPL licensed code, see LICENSE/our website https://openpgpjs.org/ for more information. */
/**

SHA1 (RFC 3174), MD5 (RFC 1321) and RIPEMD160 (RFC 2286) legacy, weak hash functions.
Don't use them in a new protocol. What "weak" means:

- Collisions can be made with 2^18 effort in MD5, 2^60 in SHA1, 2^80 in RIPEMD160.
- No practical pre-image attacks (only theoretical, 2^123.4)
- HMAC seems kinda ok: https://datatracker.ietf.org/doc/html/rfc6151
* @module
*/
/** Initial SHA1 state */
var SHA1_IV = /* @__PURE__ */ Uint32Array.from([
	1732584193,
	4023233417,
	2562383102,
	271733878,
	3285377520
]);
var SHA1_W = /* @__PURE__ */ new Uint32Array(80);
/** SHA1 legacy hash class. */
var SHA1 = class extends HashMD {
	constructor() {
		super(64, 20, 8, false);
		this.A = SHA1_IV[0] | 0;
		this.B = SHA1_IV[1] | 0;
		this.C = SHA1_IV[2] | 0;
		this.D = SHA1_IV[3] | 0;
		this.E = SHA1_IV[4] | 0;
	}
	get() {
		const { A, B, C, D, E } = this;
		return [
			A,
			B,
			C,
			D,
			E
		];
	}
	set(A, B, C, D, E) {
		this.A = A | 0;
		this.B = B | 0;
		this.C = C | 0;
		this.D = D | 0;
		this.E = E | 0;
	}
	process(view, offset) {
		for (let i = 0; i < 16; i++, offset += 4) SHA1_W[i] = view.getUint32(offset, false);
		for (let i = 16; i < 80; i++) SHA1_W[i] = rotl(SHA1_W[i - 3] ^ SHA1_W[i - 8] ^ SHA1_W[i - 14] ^ SHA1_W[i - 16], 1);
		let { A, B, C, D, E } = this;
		for (let i = 0; i < 80; i++) {
			let F, K;
			if (i < 20) {
				F = Chi$1(B, C, D);
				K = 1518500249;
			} else if (i < 40) {
				F = B ^ C ^ D;
				K = 1859775393;
			} else if (i < 60) {
				F = Maj(B, C, D);
				K = 2400959708;
			} else {
				F = B ^ C ^ D;
				K = 3395469782;
			}
			const T = rotl(A, 5) + F + E + K + SHA1_W[i] | 0;
			E = D;
			D = C;
			C = rotl(B, 30);
			B = A;
			A = T;
		}
		A = A + this.A | 0;
		B = B + this.B | 0;
		C = C + this.C | 0;
		D = D + this.D | 0;
		E = E + this.E | 0;
		this.set(A, B, C, D, E);
	}
	roundClean() {
		clean(SHA1_W);
	}
	destroy() {
		this.set(0, 0, 0, 0, 0);
		clean(this.buffer);
	}
};
/** SHA1 (RFC 3174) legacy hash function. It was cryptographically broken. */
var sha1$1 = /* @__PURE__ */ createHasher(() => new SHA1());
var Rho160 = /* @__PURE__ */ Uint8Array.from([
	7,
	4,
	13,
	1,
	10,
	6,
	15,
	3,
	12,
	0,
	9,
	5,
	2,
	14,
	11,
	8
]);
var Id160 = /* @__PURE__ */ (() => Uint8Array.from(new Array(16).fill(0).map((_, i) => i)))();
var Pi160 = /* @__PURE__ */ (() => Id160.map((i) => (9 * i + 5) % 16))();
var idxLR = /* @__PURE__ */ (() => {
	const res = [[Id160], [Pi160]];
	for (let i = 0; i < 4; i++) for (let j of res) j.push(j[i].map((k) => Rho160[k]));
	return res;
})();
var idxL = /* @__PURE__ */ (() => idxLR[0])();
var idxR = /* @__PURE__ */ (() => idxLR[1])();
var shifts160 = /* @__PURE__ */ [
	[
		11,
		14,
		15,
		12,
		5,
		8,
		7,
		9,
		11,
		13,
		14,
		15,
		6,
		7,
		9,
		8
	],
	[
		12,
		13,
		11,
		15,
		6,
		9,
		9,
		7,
		12,
		15,
		11,
		13,
		7,
		8,
		7,
		7
	],
	[
		13,
		15,
		14,
		11,
		7,
		7,
		6,
		8,
		13,
		14,
		13,
		12,
		5,
		5,
		6,
		9
	],
	[
		14,
		11,
		12,
		14,
		8,
		6,
		5,
		5,
		15,
		12,
		15,
		14,
		9,
		9,
		8,
		6
	],
	[
		15,
		12,
		13,
		13,
		9,
		5,
		8,
		6,
		14,
		11,
		12,
		11,
		8,
		6,
		5,
		5
	]
].map((i) => Uint8Array.from(i));
var shiftsL160 = /* @__PURE__ */ idxL.map((idx, i) => idx.map((j) => shifts160[i][j]));
var shiftsR160 = /* @__PURE__ */ idxR.map((idx, i) => idx.map((j) => shifts160[i][j]));
var Kl160 = /* @__PURE__ */ Uint32Array.from([
	0,
	1518500249,
	1859775393,
	2400959708,
	2840853838
]);
var Kr160 = /* @__PURE__ */ Uint32Array.from([
	1352829926,
	1548603684,
	1836072691,
	2053994217,
	0
]);
function ripemd_f(group, x, y, z) {
	if (group === 0) return x ^ y ^ z;
	if (group === 1) return x & y | ~x & z;
	if (group === 2) return (x | ~y) ^ z;
	if (group === 3) return x & z | y & ~z;
	return x ^ (y | ~z);
}
var BUF_160 = /* @__PURE__ */ new Uint32Array(16);
var RIPEMD160 = class extends HashMD {
	constructor() {
		super(64, 20, 8, true);
		this.h0 = 1732584193;
		this.h1 = -271733879;
		this.h2 = -1732584194;
		this.h3 = 271733878;
		this.h4 = -1009589776;
	}
	get() {
		const { h0, h1, h2, h3, h4 } = this;
		return [
			h0,
			h1,
			h2,
			h3,
			h4
		];
	}
	set(h0, h1, h2, h3, h4) {
		this.h0 = h0 | 0;
		this.h1 = h1 | 0;
		this.h2 = h2 | 0;
		this.h3 = h3 | 0;
		this.h4 = h4 | 0;
	}
	process(view, offset) {
		for (let i = 0; i < 16; i++, offset += 4) BUF_160[i] = view.getUint32(offset, true);
		let al = this.h0 | 0, ar = al, bl = this.h1 | 0, br = bl, cl = this.h2 | 0, cr = cl, dl = this.h3 | 0, dr = dl, el = this.h4 | 0, er = el;
		for (let group = 0; group < 5; group++) {
			const rGroup = 4 - group;
			const hbl = Kl160[group], hbr = Kr160[group];
			const rl = idxL[group], rr = idxR[group];
			const sl = shiftsL160[group], sr = shiftsR160[group];
			for (let i = 0; i < 16; i++) {
				const tl = rotl(al + ripemd_f(group, bl, cl, dl) + BUF_160[rl[i]] + hbl, sl[i]) + el | 0;
				al = el, el = dl, dl = rotl(cl, 10) | 0, cl = bl, bl = tl;
			}
			for (let i = 0; i < 16; i++) {
				const tr = rotl(ar + ripemd_f(rGroup, br, cr, dr) + BUF_160[rr[i]] + hbr, sr[i]) + er | 0;
				ar = er, er = dr, dr = rotl(cr, 10) | 0, cr = br, br = tr;
			}
		}
		this.set(this.h1 + cl + dr | 0, this.h2 + dl + er | 0, this.h3 + el + ar | 0, this.h4 + al + br | 0, this.h0 + bl + cr | 0);
	}
	roundClean() {
		clean(BUF_160);
	}
	destroy() {
		this.destroyed = true;
		clean(this.buffer);
		this.set(0, 0, 0, 0, 0);
	}
};
/**
* RIPEMD-160 - a legacy hash function from 1990s.
* * https://homes.esat.kuleuven.be/~bosselae/ripemd160.html
* * https://homes.esat.kuleuven.be/~bosselae/ripemd160/pdf/AB-9601/AB-9601.pdf
*/
var ripemd160$1 = /* @__PURE__ */ createHasher(() => new RIPEMD160());
/**
* SHA1 (RFC 3174) legacy hash function.
* @module
* @deprecated
*/
/** @deprecated Use import from `noble/hashes/legacy` module */
var sha1 = sha1$1;
/**
* RIPEMD-160 legacy hash function.
* https://homes.esat.kuleuven.be/~bosselae/ripemd160.html
* https://homes.esat.kuleuven.be/~bosselae/ripemd160/pdf/AB-9601/AB-9601.pdf
* @module
* @deprecated
*/
/** @deprecated Use import from `noble/hashes/legacy` module */
var ripemd160 = ripemd160$1;
/** @access private */
var K = Array.from({ length: 64 }, (_, i) => Math.floor(2 ** 32 * Math.abs(Math.sin(i + 1))));
var Chi = (a, b, c) => a & b ^ ~a & c;
var IV = /* @__PURE__ */ new Uint32Array([
	1732584193,
	4023233417,
	2562383102,
	271733878
]);
var MD5_W = /* @__PURE__ */ new Uint32Array(16);
var MD5 = class extends HashMD {
	constructor() {
		super(64, 16, 8, true);
		this.A = IV[0] | 0;
		this.B = IV[1] | 0;
		this.C = IV[2] | 0;
		this.D = IV[3] | 0;
	}
	get() {
		const { A, B, C, D } = this;
		return [
			A,
			B,
			C,
			D
		];
	}
	set(A, B, C, D) {
		this.A = A | 0;
		this.B = B | 0;
		this.C = C | 0;
		this.D = D | 0;
	}
	process(view, offset) {
		for (let i = 0; i < 16; i++, offset += 4) MD5_W[i] = view.getUint32(offset, true);
		let { A, B, C, D } = this;
		for (let i = 0; i < 64; i++) {
			let F, g, s;
			if (i < 16) {
				F = Chi(B, C, D);
				g = i;
				s = [
					7,
					12,
					17,
					22
				];
			} else if (i < 32) {
				F = Chi(D, B, C);
				g = (5 * i + 1) % 16;
				s = [
					5,
					9,
					14,
					20
				];
			} else if (i < 48) {
				F = B ^ C ^ D;
				g = (3 * i + 5) % 16;
				s = [
					4,
					11,
					16,
					23
				];
			} else {
				F = C ^ (B | ~D);
				g = 7 * i % 16;
				s = [
					6,
					10,
					15,
					21
				];
			}
			F = F + A + K[i] + MD5_W[g];
			A = D;
			D = C;
			C = B;
			B = B + rotl(F, s[i % 4]);
		}
		A = A + this.A | 0;
		B = B + this.B | 0;
		C = C + this.C | 0;
		D = D + this.D | 0;
		this.set(A, B, C, D);
	}
	roundClean() {
		MD5_W.fill(0);
	}
	destroy() {
		this.set(0, 0, 0, 0);
		this.buffer.fill(0);
	}
};
/**
* @access private
* This file is needed to dynamic import the noble-hashes.
* Separate dynamic imports are not convenient as they result in too many chunks,
* which share a lot of code anyway.
*/
var nobleHashes = new Map(Object.entries({
	md5: /* @__PURE__ */ wrapConstructor(() => new MD5()),
	sha1,
	sha224,
	sha256,
	sha384,
	sha512,
	sha3_256,
	sha3_512,
	ripemd160
}));
//#endregion
export { nobleHashes };

//# sourceMappingURL=noble_hashes-B7AZyFyS.js.map