//#region ../../node_modules/openpgp/dist/lightweight/argon2id.mjs
/*! OpenPGP.js v6.3.2 - 2026-09-24 - this is LGPL licensed code, see LICENSE/our website https://openpgpjs.org/ for more information. */
var globalThis$1 = typeof window !== "undefined" ? window : typeof global !== "undefined" ? global : typeof self !== "undefined" ? self : {};
function ADD64(a, i, b, j) {
	a[i] += b[j];
	a[i + 1] += b[j + 1] + (a[i] < b[j]);
}
function INC64(a, c) {
	a[0] += c;
	a[1] += a[0] < c;
}
function G$1(v, m, a, b, c, d, ix, iy) {
	ADD64(v, a, v, b);
	ADD64(v, a, m, ix);
	let xor0 = v[d] ^ v[a];
	let xor1 = v[d + 1] ^ v[a + 1];
	v[d] = xor1;
	v[d + 1] = xor0;
	ADD64(v, c, v, d);
	xor0 = v[b] ^ v[c];
	xor1 = v[b + 1] ^ v[c + 1];
	v[b] = xor0 >>> 24 ^ xor1 << 8;
	v[b + 1] = xor1 >>> 24 ^ xor0 << 8;
	ADD64(v, a, v, b);
	ADD64(v, a, m, iy);
	xor0 = v[d] ^ v[a];
	xor1 = v[d + 1] ^ v[a + 1];
	v[d] = xor0 >>> 16 ^ xor1 << 16;
	v[d + 1] = xor1 >>> 16 ^ xor0 << 16;
	ADD64(v, c, v, d);
	xor0 = v[b] ^ v[c];
	xor1 = v[b + 1] ^ v[c + 1];
	v[b] = xor1 >>> 31 ^ xor0 << 1;
	v[b + 1] = xor0 >>> 31 ^ xor1 << 1;
}
var BLAKE2B_IV32 = new Uint32Array([
	4089235720,
	1779033703,
	2227873595,
	3144134277,
	4271175723,
	1013904242,
	1595750129,
	2773480762,
	2917565137,
	1359893119,
	725511199,
	2600822924,
	4215389547,
	528734635,
	327033209,
	1541459225
]);
var SIGMA = new Uint8Array([
	0,
	1,
	2,
	3,
	4,
	5,
	6,
	7,
	8,
	9,
	10,
	11,
	12,
	13,
	14,
	15,
	14,
	10,
	4,
	8,
	9,
	15,
	13,
	6,
	1,
	12,
	0,
	2,
	11,
	7,
	5,
	3,
	11,
	8,
	12,
	0,
	5,
	2,
	15,
	13,
	10,
	14,
	3,
	6,
	7,
	1,
	9,
	4,
	7,
	9,
	3,
	1,
	13,
	12,
	11,
	14,
	2,
	6,
	5,
	10,
	4,
	0,
	15,
	8,
	9,
	0,
	5,
	7,
	2,
	4,
	10,
	15,
	14,
	1,
	11,
	12,
	6,
	8,
	3,
	13,
	2,
	12,
	6,
	10,
	0,
	11,
	8,
	3,
	4,
	13,
	7,
	5,
	15,
	14,
	1,
	9,
	12,
	5,
	1,
	15,
	14,
	13,
	4,
	10,
	0,
	7,
	6,
	3,
	9,
	2,
	8,
	11,
	13,
	11,
	7,
	14,
	12,
	1,
	3,
	9,
	5,
	0,
	15,
	4,
	8,
	6,
	2,
	10,
	6,
	15,
	14,
	9,
	11,
	3,
	0,
	8,
	12,
	2,
	13,
	7,
	1,
	4,
	10,
	5,
	10,
	2,
	8,
	4,
	7,
	6,
	1,
	5,
	15,
	11,
	9,
	14,
	3,
	12,
	13,
	0,
	0,
	1,
	2,
	3,
	4,
	5,
	6,
	7,
	8,
	9,
	10,
	11,
	12,
	13,
	14,
	15,
	14,
	10,
	4,
	8,
	9,
	15,
	13,
	6,
	1,
	12,
	0,
	2,
	11,
	7,
	5,
	3
].map((x) => x * 2));
function compress(S, last) {
	const v = /* @__PURE__ */ new Uint32Array(32);
	const m = new Uint32Array(S.b.buffer, S.b.byteOffset, 32);
	for (let i = 0; i < 16; i++) {
		v[i] = S.h[i];
		v[i + 16] = BLAKE2B_IV32[i];
	}
	v[24] ^= S.t0[0];
	v[25] ^= S.t0[1];
	const f0 = last ? 4294967295 : 0;
	v[28] ^= f0;
	v[29] ^= f0;
	for (let i = 0; i < 12; i++) {
		const i16 = i << 4;
		G$1(v, m, 0, 8, 16, 24, SIGMA[i16 + 0], SIGMA[i16 + 1]);
		G$1(v, m, 2, 10, 18, 26, SIGMA[i16 + 2], SIGMA[i16 + 3]);
		G$1(v, m, 4, 12, 20, 28, SIGMA[i16 + 4], SIGMA[i16 + 5]);
		G$1(v, m, 6, 14, 22, 30, SIGMA[i16 + 6], SIGMA[i16 + 7]);
		G$1(v, m, 0, 10, 20, 30, SIGMA[i16 + 8], SIGMA[i16 + 9]);
		G$1(v, m, 2, 12, 22, 24, SIGMA[i16 + 10], SIGMA[i16 + 11]);
		G$1(v, m, 4, 14, 16, 26, SIGMA[i16 + 12], SIGMA[i16 + 13]);
		G$1(v, m, 6, 8, 18, 28, SIGMA[i16 + 14], SIGMA[i16 + 15]);
	}
	for (let i = 0; i < 16; i++) S.h[i] ^= v[i] ^ v[i + 16];
}
var Blake2b = class {
	constructor(outlen, key, salt, personal) {
		const params = /* @__PURE__ */ new Uint8Array(64);
		this.S = {
			b: new Uint8Array(BLOCKBYTES),
			h: new Uint32Array(OUTBYTES_MAX / 4),
			t0: /* @__PURE__ */ new Uint32Array(2),
			c: 0,
			outlen
		};
		params[0] = outlen;
		if (key) params[1] = key.length;
		params[2] = 1;
		params[3] = 1;
		if (salt) params.set(salt, 32);
		if (personal) params.set(personal, 48);
		const params32 = new Uint32Array(params.buffer, params.byteOffset, params.length / Uint32Array.BYTES_PER_ELEMENT);
		for (let i = 0; i < 16; i++) this.S.h[i] = BLAKE2B_IV32[i] ^ params32[i];
		if (key) {
			const block = new Uint8Array(BLOCKBYTES);
			block.set(key);
			this.update(block);
		}
	}
	update(input) {
		if (!(input instanceof Uint8Array)) throw new Error("Input must be Uint8Array or Buffer");
		let i = 0;
		while (i < input.length) {
			if (this.S.c === BLOCKBYTES) {
				INC64(this.S.t0, this.S.c);
				compress(this.S, false);
				this.S.c = 0;
			}
			let left = BLOCKBYTES - this.S.c;
			this.S.b.set(input.subarray(i, i + left), this.S.c);
			const fill = Math.min(left, input.length - i);
			this.S.c += fill;
			i += fill;
		}
		return this;
	}
	/**
	* Return a BLAKE2b hash, either filling the given Uint8Array or allocating a new one
	* @param {Uint8Array} [prealloc] - optional preallocated buffer
	* @returns {ArrayBuffer} message digest
	*/
	digest(prealloc) {
		INC64(this.S.t0, this.S.c);
		this.S.b.fill(0, this.S.c);
		this.S.c = BLOCKBYTES;
		compress(this.S, true);
		const out = prealloc || new Uint8Array(this.S.outlen);
		for (let i = 0; i < this.S.outlen; i++) out[i] = this.S.h[i >> 2] >> 8 * (i & 3);
		this.S.h = null;
		return out.buffer;
	}
};
function createHash(outlen, key, salt, personal) {
	if (outlen > OUTBYTES_MAX) throw new Error(`outlen must be at most ${OUTBYTES_MAX} (given: ${outlen})`);
	return new Blake2b(outlen, key, salt, personal);
}
var OUTBYTES_MAX = 64;
var BLOCKBYTES = 128;
var TYPE = 2;
var VERSION = 19;
var TAGBYTES_MAX = 4294967295;
var TAGBYTES_MIN = 4;
var SALTBYTES_MAX = 4294967295;
var SALTBYTES_MIN = 8;
var passwordBYTES_MAX = 4294967295;
var passwordBYTES_MIN = 8;
var MEMBYTES_MAX = 4294967295;
var ADBYTES_MAX = 4294967295;
var SECRETBYTES_MAX = 32;
var ARGON2_BLOCK_SIZE = 1024;
var ARGON2_PREHASH_DIGEST_LENGTH = 64;
var isLittleEndian = new Uint8Array(new Uint16Array([43981]).buffer)[0] === 205;
function LE32(buf, n, i) {
	buf[i + 0] = n;
	buf[i + 1] = n >> 8;
	buf[i + 2] = n >> 16;
	buf[i + 3] = n >> 24;
	return buf;
}
/**
* Store n as a 64-bit LE number in the given buffer (from buf[i] to buf[i+7])
* @param {Uint8Array} buf
* @param {Number} n
* @param {Number} i
*/
function LE64(buf, n, i) {
	if (n > Number.MAX_SAFE_INTEGER) throw new Error("LE64: large numbers unsupported");
	let remainder = n;
	for (let offset = i; offset < i + 7; offset++) {
		buf[offset] = remainder;
		remainder = (remainder - buf[offset]) / 256;
	}
	return buf;
}
/**
* Variable-Length Hash Function H'
* @param {Number} outlen - T
* @param {Uint8Array} X - value to hash
* @param {Uint8Array} res - output buffer, of length `outlength` or larger
*/
function H_(outlen, X, res) {
	const V = /* @__PURE__ */ new Uint8Array(64);
	const V1_in = new Uint8Array(4 + X.length);
	LE32(V1_in, outlen, 0);
	V1_in.set(X, 4);
	if (outlen <= 64) {
		createHash(outlen).update(V1_in).digest(res);
		return res;
	}
	const r = Math.ceil(outlen / 32) - 2;
	for (let i = 0; i < r; i++) {
		createHash(64).update(i === 0 ? V1_in : V).digest(V);
		res.set(V.subarray(0, 32), i * 32);
	}
	const V_r1 = new Uint8Array(createHash(outlen - 32 * r).update(V).digest());
	res.set(V_r1, r * 32);
	return res;
}
function XOR(wasmContext, buf, xs, ys) {
	wasmContext.fn.XOR(buf.byteOffset, xs.byteOffset, ys.byteOffset);
	return buf;
}
/**
* @param {Uint8Array} X (read-only)
* @param {Uint8Array} Y (read-only)
* @param {Uint8Array} R - output buffer
* @returns
*/
function G(wasmContext, X, Y, R) {
	wasmContext.fn.G(X.byteOffset, Y.byteOffset, R.byteOffset, wasmContext.refs.gZ.byteOffset);
	return R;
}
function G2(wasmContext, X, Y, R) {
	wasmContext.fn.G2(X.byteOffset, Y.byteOffset, R.byteOffset, wasmContext.refs.gZ.byteOffset);
	return R;
}
function* makePRNG(wasmContext, pass, lane, slice, m_, totalPasses, segmentLength, segmentOffset) {
	wasmContext.refs.prngTmp.fill(0);
	const Z = wasmContext.refs.prngTmp.subarray(0, 48);
	LE64(Z, pass, 0);
	LE64(Z, lane, 8);
	LE64(Z, slice, 16);
	LE64(Z, m_, 24);
	LE64(Z, totalPasses, 32);
	LE64(Z, TYPE, 40);
	for (let i = 1; i <= segmentLength; i++) {
		LE64(wasmContext.refs.prngTmp, i, Z.length);
		const g2 = G2(wasmContext, wasmContext.refs.ZERO1024, wasmContext.refs.prngTmp, wasmContext.refs.prngR);
		for (let k = i === 1 ? segmentOffset * 8 : 0; k < g2.length; k += 8) yield g2.subarray(k, k + 8);
	}
	return [];
}
function validateParams({ type, version, tagLength, password, salt, ad, secret, parallelism, memorySize, passes }) {
	const assertLength = (name, value, min, max) => {
		if (value < min || value > max) throw new Error(`${name} size should be between ${min} and ${max} bytes`);
	};
	if (type !== TYPE || version !== VERSION) throw new Error("Unsupported type or version");
	assertLength("password", password, passwordBYTES_MIN, passwordBYTES_MAX);
	assertLength("salt", salt, SALTBYTES_MIN, SALTBYTES_MAX);
	assertLength("tag", tagLength, TAGBYTES_MIN, TAGBYTES_MAX);
	assertLength("memory", memorySize, 8 * parallelism, MEMBYTES_MAX);
	ad && assertLength("associated data", ad, 0, ADBYTES_MAX);
	secret && assertLength("secret", secret, 0, SECRETBYTES_MAX);
	return {
		type,
		version,
		tagLength,
		password,
		salt,
		ad,
		secret,
		lanes: parallelism,
		memorySize,
		passes
	};
}
var KB = 1024;
var WASM_PAGE_SIZE = 64 * KB;
function argon2id(params, { memory, instance: wasmInstance }) {
	if (!isLittleEndian) throw new Error("BigEndian system not supported");
	const ctx = validateParams({
		type: TYPE,
		version: VERSION,
		...params
	});
	const { G: wasmG, G2: wasmG2, xor: wasmXOR, getLZ: wasmLZ } = wasmInstance.exports;
	const wasmRefs = {};
	const wasmFn = {};
	wasmFn.G = wasmG;
	wasmFn.G2 = wasmG2;
	wasmFn.XOR = wasmXOR;
	const m_ = 4 * ctx.lanes * Math.floor(ctx.memorySize / (4 * ctx.lanes));
	const requiredMemory = m_ * ARGON2_BLOCK_SIZE + 10 * KB;
	if (memory.buffer.byteLength < requiredMemory) {
		const missing = Math.ceil((requiredMemory - memory.buffer.byteLength) / WASM_PAGE_SIZE);
		memory.grow(missing);
	}
	let offset = 0;
	wasmRefs.gZ = new Uint8Array(memory.buffer, offset, ARGON2_BLOCK_SIZE);
	offset += wasmRefs.gZ.length;
	wasmRefs.prngR = new Uint8Array(memory.buffer, offset, ARGON2_BLOCK_SIZE);
	offset += wasmRefs.prngR.length;
	wasmRefs.prngTmp = new Uint8Array(memory.buffer, offset, ARGON2_BLOCK_SIZE);
	offset += wasmRefs.prngTmp.length;
	wasmRefs.ZERO1024 = new Uint8Array(memory.buffer, offset, 1024);
	offset += wasmRefs.ZERO1024.length;
	const lz = new Uint32Array(memory.buffer, offset, 2);
	offset += lz.length * Uint32Array.BYTES_PER_ELEMENT;
	const wasmContext = {
		fn: wasmFn,
		refs: wasmRefs
	};
	const newBlock = new Uint8Array(memory.buffer, offset, ARGON2_BLOCK_SIZE);
	offset += newBlock.length;
	const blockMemory = new Uint8Array(memory.buffer, offset, ctx.memorySize * ARGON2_BLOCK_SIZE);
	const allocatedMemory = new Uint8Array(memory.buffer, 0, offset);
	const H0 = getH0(ctx);
	const q = m_ / ctx.lanes;
	const B = new Array(ctx.lanes).fill(null).map(() => new Array(q));
	const initBlock = (i, j) => {
		B[i][j] = blockMemory.subarray(i * q * 1024 + j * 1024, i * q * 1024 + j * 1024 + ARGON2_BLOCK_SIZE);
		return B[i][j];
	};
	for (let i = 0; i < ctx.lanes; i++) {
		const tmp = new Uint8Array(H0.length + 8);
		tmp.set(H0);
		LE32(tmp, 0, H0.length);
		LE32(tmp, i, H0.length + 4);
		H_(ARGON2_BLOCK_SIZE, tmp, initBlock(i, 0));
		LE32(tmp, 1, H0.length);
		H_(ARGON2_BLOCK_SIZE, tmp, initBlock(i, 1));
	}
	const SL = 4;
	const segmentLength = q / SL;
	for (let pass = 0; pass < ctx.passes; pass++) for (let sl = 0; sl < SL; sl++) {
		const isDataIndependent = pass === 0 && sl <= 1;
		for (let i = 0; i < ctx.lanes; i++) {
			let segmentOffset = sl === 0 && pass === 0 ? 2 : 0;
			const PRNG = isDataIndependent ? makePRNG(wasmContext, pass, i, sl, m_, ctx.passes, segmentLength, segmentOffset) : null;
			for (; segmentOffset < segmentLength; segmentOffset++) {
				const j = sl * segmentLength + segmentOffset;
				const prevBlock = j > 0 ? B[i][j - 1] : B[i][q - 1];
				const J1J2 = isDataIndependent ? PRNG.next().value : prevBlock;
				wasmLZ(lz.byteOffset, J1J2.byteOffset, i, ctx.lanes, pass, sl, segmentOffset, SL, segmentLength);
				const l = lz[0];
				const z = lz[1];
				if (pass === 0) initBlock(i, j);
				G(wasmContext, prevBlock, B[l][z], pass > 0 ? newBlock : B[i][j]);
				if (pass > 0) XOR(wasmContext, B[i][j], newBlock, B[i][j]);
			}
		}
	}
	const C = B[0][q - 1];
	for (let i = 1; i < ctx.lanes; i++) XOR(wasmContext, C, C, B[i][q - 1]);
	const tag = H_(ctx.tagLength, C, new Uint8Array(ctx.tagLength));
	allocatedMemory.fill(0);
	memory.grow(0);
	return tag;
}
function getH0(ctx) {
	const H = createHash(ARGON2_PREHASH_DIGEST_LENGTH);
	const ZERO32 = /* @__PURE__ */ new Uint8Array(4);
	const params = /* @__PURE__ */ new Uint8Array(24);
	LE32(params, ctx.lanes, 0);
	LE32(params, ctx.tagLength, 4);
	LE32(params, ctx.memorySize, 8);
	LE32(params, ctx.passes, 12);
	LE32(params, ctx.version, 16);
	LE32(params, ctx.type, 20);
	const toHash = [params];
	if (ctx.password) {
		toHash.push(LE32(/* @__PURE__ */ new Uint8Array(4), ctx.password.length, 0));
		toHash.push(ctx.password);
	} else toHash.push(ZERO32);
	if (ctx.salt) {
		toHash.push(LE32(/* @__PURE__ */ new Uint8Array(4), ctx.salt.length, 0));
		toHash.push(ctx.salt);
	} else toHash.push(ZERO32);
	if (ctx.secret) {
		toHash.push(LE32(/* @__PURE__ */ new Uint8Array(4), ctx.secret.length, 0));
		toHash.push(ctx.secret);
	} else toHash.push(ZERO32);
	if (ctx.ad) {
		toHash.push(LE32(/* @__PURE__ */ new Uint8Array(4), ctx.ad.length, 0));
		toHash.push(ctx.ad);
	} else toHash.push(ZERO32);
	H.update(concatArrays(toHash));
	const outputBuffer = H.digest();
	return new Uint8Array(outputBuffer);
}
function concatArrays(arrays) {
	if (arrays.length === 1) return arrays[0];
	let totalLength = 0;
	for (let i = 0; i < arrays.length; i++) {
		if (!(arrays[i] instanceof Uint8Array)) throw new Error("concatArrays: Data must be in the form of a Uint8Array");
		totalLength += arrays[i].length;
	}
	const result = new Uint8Array(totalLength);
	let pos = 0;
	arrays.forEach((element) => {
		result.set(element, pos);
		pos += element.length;
	});
	return result;
}
var isSIMDSupported;
async function wasmLoader(memory, getSIMD, getNonSIMD) {
	const importObject = { env: { memory } };
	if (isSIMDSupported === void 0) try {
		const loaded = await getSIMD(importObject);
		isSIMDSupported = true;
		return loaded;
	} catch (e) {
		isSIMDSupported = false;
	}
	return (isSIMDSupported ? getSIMD : getNonSIMD)(importObject);
}
async function setupWasm(getSIMD, getNonSIMD) {
	const memory = new WebAssembly.Memory({
		initial: 1040,
		maximum: 65536
	});
	const wasmModule = await wasmLoader(memory, getSIMD, getNonSIMD);
	/**
	* Argon2id hash function
	* @callback computeHash
	* @param {Object} params
	* @param {Uint8Array} params.password - password
	* @param {Uint8Array} params.salt - salt
	* @param {Integer} params.parallelism
	* @param {Integer} params.passes
	* @param {Integer} params.memorySize - in kibibytes
	* @param {Integer} params.tagLength - output tag length
	* @param {Uint8Array} [params.ad] - associated data (optional)
	* @param {Uint8Array} [params.secret] - secret data (optional)
	* @return {Uint8Array} argon2id hash
	*/
	const computeHash = (params) => argon2id(params, {
		instance: wasmModule.instance,
		memory
	});
	return computeHash;
}
function _loadWasmModule(sync, filepath, src, imports) {
	function _instantiateOrCompile(source, imports, stream) {
		var instantiateFunc = stream ? WebAssembly.instantiateStreaming : WebAssembly.instantiate;
		var compileFunc = stream ? WebAssembly.compileStreaming : WebAssembly.compile;
		if (imports) return instantiateFunc(source, imports);
		else return compileFunc(source);
	}
	var buf = null;
	var raw = globalThis$1.atob(src);
	var rawLength = raw.length;
	buf = new Uint8Array(new ArrayBuffer(rawLength));
	for (var i = 0; i < rawLength; i++) buf[i] = raw.charCodeAt(i);
	return _instantiateOrCompile(buf, imports, false);
}
function wasmSIMD(imports) {
	return _loadWasmModule(0, null, "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", imports);
}
function wasmNonSIMD(imports) {
	return _loadWasmModule(0, null, "AGFzbQEAAAABPwhgBH9/f38AYAABf2AAAGADf39/AGARf39/f39/f39/f39/f39/f38AYAl/f39/f39/f38Bf2ABfwBgAX8BfwITAQNlbnYGbWVtb3J5AgGQCICABAMLCgIDBAAABQEGBwEEBQFwAQICBgkBfwFBkIjAAgsHfQoDeG9yAAEBRwADAkcyAAQFZ2V0TFoABRlfX2luZGlyZWN0X2Z1bmN0aW9uX3RhYmxlAQALX2luaXRpYWxpemUAABBfX2Vycm5vX2xvY2F0aW9uAAkJc3RhY2tTYXZlAAYMc3RhY2tSZXN0b3JlAAcKc3RhY2tBbGxvYwAICQcBAEEBCwEACssaCgMAAQtQAQJ/A0AgACAEQQN0IgNqIAIgA2opAwAgASADaikDAIU3AwAgACADQQhyIgNqIAIgA2opAwAgASADaikDAIU3AwAgBEECaiIEQYABRw0ACwveDwICfgF/IAAgAUEDdGoiEyATKQMAIhEgACAFQQN0aiIBKQMAIhJ8IBFCAYZC/v///x+DIBJC/////w+DfnwiETcDACAAIA1BA3RqIgUgESAFKQMAhUIgiSIRNwMAIAAgCUEDdGoiCSARIAkpAwAiEnwgEUL/////D4MgEkIBhkL+////H4N+fCIRNwMAIAEgESABKQMAhUIoiSIRNwMAIBMgESATKQMAIhJ8IBFC/////w+DIBJCAYZC/v///x+DfnwiETcDACAFIBEgBSkDAIVCMIkiETcDACAJIBEgCSkDACISfCARQv////8PgyASQgGGQv7///8fg358IhE3AwAgASARIAEpAwCFQgGJNwMAIAAgAkEDdGoiDSANKQMAIhEgACAGQQN0aiICKQMAIhJ8IBFCAYZC/v///x+DIBJC/////w+DfnwiETcDACAAIA5BA3RqIgYgESAGKQMAhUIgiSIRNwMAIAAgCkEDdGoiCiARIAopAwAiEnwgEUL/////D4MgEkIBhkL+////H4N+fCIRNwMAIAIgESACKQMAhUIoiSIRNwMAIA0gESANKQMAIhJ8IBFC/////w+DIBJCAYZC/v///x+DfnwiETcDACAGIBEgBikDAIVCMIkiETcDACAKIBEgCikDACISfCARQv////8PgyASQgGGQv7///8fg358IhE3AwAgAiARIAIpAwCFQgGJNwMAIAAgA0EDdGoiDiAOKQMAIhEgACAHQQN0aiIDKQMAIhJ8IBFCAYZC/v///x+DIBJC/////w+DfnwiETcDACAAIA9BA3RqIgcgESAHKQMAhUIgiSIRNwMAIAAgC0EDdGoiCyARIAspAwAiEnwgEUL/////D4MgEkIBhkL+////H4N+fCIRNwMAIAMgESADKQMAhUIoiSIRNwMAIA4gESAOKQMAIhJ8IBFC/////w+DIBJCAYZC/v///x+DfnwiETcDACAHIBEgBykDAIVCMIkiETcDACALIBEgCykDACISfCARQv////8PgyASQgGGQv7///8fg358IhE3AwAgAyARIAMpAwCFQgGJNwMAIAAgBEEDdGoiDyAPKQMAIhEgACAIQQN0aiIEKQMAIhJ8IBFCAYZC/v///x+DIBJC/////w+DfnwiETcDACAAIBBBA3RqIgggESAIKQMAhUIgiSIRNwMAIAAgDEEDdGoiACARIAApAwAiEnwgEUL/////D4MgEkIBhkL+////H4N+fCIRNwMAIAQgESAEKQMAhUIoiSIRNwMAIA8gESAPKQMAIhJ8IBFC/////w+DIBJCAYZC/v///x+DfnwiETcDACAIIBEgCCkDAIVCMIkiETcDACAAIBEgACkDACISfCARQv////8PgyASQgGGQv7///8fg358IhE3AwAgBCARIAQpAwCFQgGJNwMAIBMgEykDACIRIAIpAwAiEnwgEUIBhkL+////H4MgEkL/////D4N+fCIRNwMAIAggESAIKQMAhUIgiSIRNwMAIAsgESALKQMAIhJ8IBFC/////w+DIBJCAYZC/v///x+DfnwiETcDACACIBEgAikDAIVCKIkiETcDACATIBEgEykDACISfCARQv////8PgyASQgGGQv7///8fg358IhE3AwAgCCARIAgpAwCFQjCJIhE3AwAgCyARIAspAwAiEnwgEUL/////D4MgEkIBhkL+////H4N+fCIRNwMAIAIgESACKQMAhUIBiTcDACANIA0pAwAiESADKQMAIhJ8IBFCAYZC/v///x+DIBJC/////w+DfnwiETcDACAFIBEgBSkDAIVCIIkiETcDACAAIBEgACkDACISfCARQv////8PgyASQgGGQv7///8fg358IhE3AwAgAyARIAMpAwCFQiiJIhE3AwAgDSARIA0pAwAiEnwgEUL/////D4MgEkIBhkL+////H4N+fCIRNwMAIAUgESAFKQMAhUIwiSIRNwMAIAAgESAAKQMAIhJ8IBFC/////w+DIBJCAYZC/v///x+DfnwiETcDACADIBEgAykDAIVCAYk3AwAgDiAOKQMAIhEgBCkDACISfCARQgGGQv7///8fgyASQv////8Pg358IhE3AwAgBiARIAYpAwCFQiCJIhE3AwAgCSARIAkpAwAiEnwgEUL/////D4MgEkIBhkL+////H4N+fCIRNwMAIAQgESAEKQMAhUIoiSIRNwMAIA4gESAOKQMAIhJ8IBFC/////w+DIBJCAYZC/v///x+DfnwiETcDACAGIBEgBikDAIVCMIkiETcDACAJIBEgCSkDACISfCARQv////8PgyASQgGGQv7///8fg358IhE3AwAgBCARIAQpAwCFQgGJNwMAIA8gDykDACIRIAEpAwAiEnwgEUIBhkL+////H4MgEkL/////D4N+fCIRNwMAIAcgESAHKQMAhUIgiSIRNwMAIAogESAKKQMAIhJ8IBFC/////w+DIBJCAYZC/v///x+DfnwiETcDACABIBEgASkDAIVCKIkiETcDACAPIBEgDykDACISfCARQv////8PgyASQgGGQv7///8fg358IhE3AwAgByARIAcpAwCFQjCJIhE3AwAgCiARIAopAwAiEnwgEUL/////D4MgEkIBhkL+////H4N+fCIRNwMAIAEgESABKQMAhUIBiTcDAAvdCAEPfwNAIAIgBUEDdCIGaiABIAZqKQMAIAAgBmopAwCFNwMAIAIgBkEIciIGaiABIAZqKQMAIAAgBmopAwCFNwMAIAVBAmoiBUGAAUcNAAsDQCADIARBA3QiAGogACACaikDADcDACADIARBAXIiAEEDdCIBaiABIAJqKQMANwMAIAMgBEECciIBQQN0IgVqIAIgBWopAwA3AwAgAyAEQQNyIgVBA3QiBmogAiAGaikDADcDACADIARBBHIiBkEDdCIHaiACIAdqKQMANwMAIAMgBEEFciIHQQN0IghqIAIgCGopAwA3AwAgAyAEQQZyIghBA3QiCWogAiAJaikDADcDACADIARBB3IiCUEDdCIKaiACIApqKQMANwMAIAMgBEEIciIKQQN0IgtqIAIgC2opAwA3AwAgAyAEQQlyIgtBA3QiDGogAiAMaikDADcDACADIARBCnIiDEEDdCINaiACIA1qKQMANwMAIAMgBEELciINQQN0Ig5qIAIgDmopAwA3AwAgAyAEQQxyIg5BA3QiD2ogAiAPaikDADcDACADIARBDXIiD0EDdCIQaiACIBBqKQMANwMAIAMgBEEOciIQQQN0IhFqIAIgEWopAwA3AwAgAyAEQQ9yIhFBA3QiEmogAiASaikDADcDACADIARB//8DcSAAQf//A3EgAUH//wNxIAVB//8DcSAGQf//A3EgB0H//wNxIAhB//8DcSAJQf//A3EgCkH//wNxIAtB//8DcSAMQf//A3EgDUH//wNxIA5B//8DcSAPQf//A3EgEEH//wNxIBFB//8DcRACIARB8ABJIQAgBEEQaiEEIAANAAtBACEBIANBAEEBQRBBEUEgQSFBMEExQcAAQcEAQdAAQdEAQeAAQeEAQfAAQfEAEAIgA0ECQQNBEkETQSJBI0EyQTNBwgBBwwBB0gBB0wBB4gBB4wBB8gBB8wAQAiADQQRBBUEUQRVBJEElQTRBNUHEAEHFAEHUAEHVAEHkAEHlAEH0AEH1ABACIANBBkEHQRZBF0EmQSdBNkE3QcYAQccAQdYAQdcAQeYAQecAQfYAQfcAEAIgA0EIQQlBGEEZQShBKUE4QTlByABByQBB2ABB2QBB6ABB6QBB+ABB+QAQAiADQQpBC0EaQRtBKkErQTpBO0HKAEHLAEHaAEHbAEHqAEHrAEH6AEH7ABACIANBDEENQRxBHUEsQS1BPEE9QcwAQc0AQdwAQd0AQewAQe0AQfwAQf0AEAIgA0EOQQ9BHkEfQS5BL0E+QT9BzgBBzwBB3gBB3wBB7gBB7wBB/gBB/wAQAgNAIAIgAUEDdCIAaiIEIAAgA2opAwAgBCkDAIU3AwAgAiAAQQhyIgRqIgUgAyAEaikDACAFKQMAhTcDACACIABBEHIiBGoiBSADIARqKQMAIAUpAwCFNwMAIAIgAEEYciIAaiIEIAAgA2opAwAgBCkDAIU3AwAgAUEEaiIBQYABRw0ACwsWACAAIAEgAiADEAMgACACIAIgAxADC3sCAX8BfiACIQkgATUCACEKIAQgBXIEQCABKAIEIANwIQkLIAAgCTYCACAAIAdBAWsgBSAEGyAIbCAGQQFrQQBBfyAGGyACIAlGG2oiASAFQQFqIAhsQQAgBBtqIAGtIAogCn5CIIh+QiCIp0F/c2ogByAIbHA2AgQgAAsEACMACwYAIAAkAAsQACMAIABrQXBxIgAkACAACwUAQYAICw==", imports);
}
var loadWasm = async () => setupWasm((instanceObject) => wasmSIMD(instanceObject), (instanceObject) => wasmNonSIMD(instanceObject));
//#endregion
export { loadWasm as default };

//# sourceMappingURL=argon2id-088uQfnH.js.map