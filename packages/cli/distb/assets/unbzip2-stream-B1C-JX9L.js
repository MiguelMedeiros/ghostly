//#region ../../node_modules/openpgp/dist/lightweight/unbzip2-stream.mjs
/*! OpenPGP.js v6.3.2 - 2026-09-24 - this is LGPL licensed code, see LICENSE/our website https://openpgpjs.org/ for more information. */
function _mergeNamespaces(n, m) {
	m.forEach(function(e) {
		e && typeof e !== "string" && !Array.isArray(e) && Object.keys(e).forEach(function(k) {
			if (k !== "default" && !(k in n)) {
				var d = Object.getOwnPropertyDescriptor(e, k);
				Object.defineProperty(n, k, d.get ? d : {
					enumerable: true,
					get: function() {
						return e[k];
					}
				});
			}
		});
	});
	return Object.freeze(n);
}
function getDefaultExportFromCjs(x) {
	return x && x.__esModule && Object.prototype.hasOwnProperty.call(x, "default") ? x["default"] : x;
}
var bzip2_1;
var hasRequiredBzip2;
function requireBzip2() {
	if (hasRequiredBzip2) return bzip2_1;
	hasRequiredBzip2 = 1;
	function Bzip2Error(message) {
		this.name = "Bzip2Error";
		this.message = message;
		this.stack = (/* @__PURE__ */ new Error()).stack;
	}
	Bzip2Error.prototype = /* @__PURE__ */ new Error();
	var message = { Error: function(message) {
		throw new Bzip2Error(message);
	} };
	var bzip2 = {};
	bzip2.Bzip2Error = Bzip2Error;
	bzip2.crcTable = [
		0,
		79764919,
		159529838,
		222504665,
		319059676,
		398814059,
		445009330,
		507990021,
		638119352,
		583659535,
		797628118,
		726387553,
		890018660,
		835552979,
		1015980042,
		944750013,
		1276238704,
		1221641927,
		1167319070,
		1095957929,
		1595256236,
		1540665371,
		1452775106,
		1381403509,
		1780037320,
		1859660671,
		1671105958,
		1733955601,
		2031960084,
		2111593891,
		1889500026,
		1952343757,
		2552477408,
		2632100695,
		2443283854,
		2506133561,
		2334638140,
		2414271883,
		2191915858,
		2254759653,
		3190512472,
		3135915759,
		3081330742,
		3009969537,
		2905550212,
		2850959411,
		2762807018,
		2691435357,
		3560074640,
		3505614887,
		3719321342,
		3648080713,
		3342211916,
		3287746299,
		3467911202,
		3396681109,
		4063920168,
		4143685023,
		4223187782,
		4286162673,
		3779000052,
		3858754371,
		3904687514,
		3967668269,
		881225847,
		809987520,
		1023691545,
		969234094,
		662832811,
		591600412,
		771767749,
		717299826,
		311336399,
		374308984,
		453813921,
		533576470,
		25881363,
		88864420,
		134795389,
		214552010,
		2023205639,
		2086057648,
		1897238633,
		1976864222,
		1804852699,
		1867694188,
		1645340341,
		1724971778,
		1587496639,
		1516133128,
		1461550545,
		1406951526,
		1302016099,
		1230646740,
		1142491917,
		1087903418,
		2896545431,
		2825181984,
		2770861561,
		2716262478,
		3215044683,
		3143675388,
		3055782693,
		3001194130,
		2326604591,
		2389456536,
		2200899649,
		2280525302,
		2578013683,
		2640855108,
		2418763421,
		2498394922,
		3769900519,
		3832873040,
		3912640137,
		3992402750,
		4088425275,
		4151408268,
		4197601365,
		4277358050,
		3334271071,
		3263032808,
		3476998961,
		3422541446,
		3585640067,
		3514407732,
		3694837229,
		3640369242,
		1762451694,
		1842216281,
		1619975040,
		1682949687,
		2047383090,
		2127137669,
		1938468188,
		2001449195,
		1325665622,
		1271206113,
		1183200824,
		1111960463,
		1543535498,
		1489069629,
		1434599652,
		1363369299,
		622672798,
		568075817,
		748617968,
		677256519,
		907627842,
		853037301,
		1067152940,
		995781531,
		51762726,
		131386257,
		177728840,
		240578815,
		269590778,
		349224269,
		429104020,
		491947555,
		4046411278,
		4126034873,
		4172115296,
		4234965207,
		3794477266,
		3874110821,
		3953728444,
		4016571915,
		3609705398,
		3555108353,
		3735388376,
		3664026991,
		3290680682,
		3236090077,
		3449943556,
		3378572211,
		3174993278,
		3120533705,
		3032266256,
		2961025959,
		2923101090,
		2868635157,
		2813903052,
		2742672763,
		2604032198,
		2683796849,
		2461293480,
		2524268063,
		2284983834,
		2364738477,
		2175806836,
		2238787779,
		1569362073,
		1498123566,
		1409854455,
		1355396672,
		1317987909,
		1246755826,
		1192025387,
		1137557660,
		2072149281,
		2135122070,
		1912620623,
		1992383480,
		1753615357,
		1816598090,
		1627664531,
		1707420964,
		295390185,
		358241886,
		404320391,
		483945776,
		43990325,
		106832002,
		186451547,
		266083308,
		932423249,
		861060070,
		1041341759,
		986742920,
		613929101,
		542559546,
		756411363,
		701822548,
		3316196985,
		3244833742,
		3425377559,
		3370778784,
		3601682597,
		3530312978,
		3744426955,
		3689838204,
		3819031489,
		3881883254,
		3928223919,
		4007849240,
		4037393693,
		4100235434,
		4180117107,
		4259748804,
		2310601993,
		2373574846,
		2151335527,
		2231098320,
		2596047829,
		2659030626,
		2470359227,
		2550115596,
		2947551409,
		2876312838,
		2788305887,
		2733848168,
		3165939309,
		3094707162,
		3040238851,
		2985771188
	];
	bzip2.array = function(bytes) {
		var bit = 0, byte = 0;
		var BITMASK = [
			0,
			1,
			3,
			7,
			15,
			31,
			63,
			127,
			255
		];
		return function(n) {
			var result = 0;
			while (n > 0) {
				var left = 8 - bit;
				if (n >= left) {
					result <<= left;
					result |= BITMASK[left] & bytes[byte++];
					bit = 0;
					n -= left;
				} else {
					result <<= n;
					result |= (bytes[byte] & BITMASK[n] << 8 - n - bit) >> 8 - n - bit;
					bit += n;
					n = 0;
				}
			}
			return result;
		};
	};
	bzip2.simple = function(srcbuffer, stream) {
		var bits = bzip2.array(srcbuffer);
		var size = bzip2.header(bits);
		var ret = false;
		var bufsize = 1e5 * size;
		var buf = new Int32Array(bufsize);
		do
			ret = bzip2.decompress(bits, stream, buf, bufsize);
		while (!ret);
	};
	bzip2.header = function(bits) {
		this.byteCount = /* @__PURE__ */ new Int32Array(256);
		this.symToByte = /* @__PURE__ */ new Uint8Array(256);
		this.mtfSymbol = /* @__PURE__ */ new Int32Array(256);
		this.selectors = /* @__PURE__ */ new Uint8Array(32768);
		if (bits(24) != 4348520) message.Error("No magic number found");
		var i = bits(8) - 48;
		if (i < 1 || i > 9) message.Error("Not a BZIP archive");
		return i;
	};
	bzip2.decompress = function(bits, stream, buf, bufsize, streamCRC) {
		var MAX_HUFCODE_BITS = 20;
		var MAX_SYMBOLS = 258;
		var SYMBOL_RUNA = 0;
		var SYMBOL_RUNB = 1;
		var GROUP_SIZE = 50;
		var crc = -1;
		for (var h = "", i = 0; i < 6; i++) h += bits(8).toString(16);
		if (h == "177245385090") {
			if ((bits(32) | 0) !== streamCRC) message.Error("Error in bzip2: crc32 do not match");
			bits(null);
			return null;
		}
		if (h != "314159265359") message.Error("Invalid bzip data");
		var crcblock = bits(32) | 0;
		if (bits(1)) message.Error("unsupported obsolete version");
		var origPtr = bits(24);
		if (origPtr > bufsize) message.Error("Initial position larger than buffer size");
		var t = bits(16);
		var symTotal = 0;
		for (i = 0; i < 16; i++) if (t & 1 << 15 - i) {
			var k = bits(16);
			for (j = 0; j < 16; j++) if (k & 1 << 15 - j) this.symToByte[symTotal++] = 16 * i + j;
		}
		var groupCount = bits(3);
		if (groupCount < 2 || groupCount > 6) message.Error("Invalid bzip data");
		var nSelectors = bits(15);
		if (nSelectors == 0) message.Error("Invalid bzip data");
		for (var i = 0; i < groupCount; i++) this.mtfSymbol[i] = i;
		for (var i = 0; i < nSelectors; i++) {
			for (var j = 0; bits(1); j++) if (j >= groupCount) message.Error("Invalid bzip data");
			var uc = this.mtfSymbol[j];
			for (var k = j - 1; k >= 0; k--) this.mtfSymbol[k + 1] = this.mtfSymbol[k];
			this.mtfSymbol[0] = uc;
			this.selectors[i] = uc;
		}
		var symCount = symTotal + 2;
		var groups = [];
		var length = new Uint8Array(MAX_SYMBOLS), temp = new Uint16Array(MAX_HUFCODE_BITS + 1);
		var hufGroup;
		for (var j = 0; j < groupCount; j++) {
			t = bits(5);
			for (var i = 0; i < symCount; i++) {
				while (true) {
					if (t < 1 || t > MAX_HUFCODE_BITS) message.Error("Invalid bzip data");
					if (!bits(1)) break;
					if (!bits(1)) t++;
					else t--;
				}
				length[i] = t;
			}
			var minLen = maxLen = length[0], maxLen;
			for (var i = 1; i < symCount; i++) if (length[i] > maxLen) maxLen = length[i];
			else if (length[i] < minLen) minLen = length[i];
			hufGroup = groups[j] = {};
			hufGroup.permute = new Int32Array(MAX_SYMBOLS);
			hufGroup.limit = new Int32Array(MAX_HUFCODE_BITS + 1);
			hufGroup.base = new Int32Array(MAX_HUFCODE_BITS + 1);
			hufGroup.minLen = minLen;
			hufGroup.maxLen = maxLen;
			var base = hufGroup.base;
			var limit = hufGroup.limit;
			var pp = 0;
			for (var i = minLen; i <= maxLen; i++) for (var t = 0; t < symCount; t++) if (length[t] == i) hufGroup.permute[pp++] = t;
			for (i = minLen; i <= maxLen; i++) temp[i] = limit[i] = 0;
			for (i = 0; i < symCount; i++) temp[length[i]]++;
			pp = t = 0;
			for (i = minLen; i < maxLen; i++) {
				pp += temp[i];
				limit[i] = pp - 1;
				pp <<= 1;
				base[i + 1] = pp - (t += temp[i]);
			}
			limit[maxLen] = pp + temp[maxLen] - 1;
			base[minLen] = 0;
		}
		for (var i = 0; i < 256; i++) {
			this.mtfSymbol[i] = i;
			this.byteCount[i] = 0;
		}
		var runPos = count = symCount = selector = 0, count, symCount, selector;
		while (true) {
			if (!symCount--) {
				symCount = GROUP_SIZE - 1;
				if (selector >= nSelectors) message.Error("Invalid bzip data");
				hufGroup = groups[this.selectors[selector++]];
				base = hufGroup.base;
				limit = hufGroup.limit;
			}
			i = hufGroup.minLen;
			j = bits(i);
			while (true) {
				if (i > hufGroup.maxLen) message.Error("Invalid bzip data");
				if (j <= limit[i]) break;
				i++;
				j = j << 1 | bits(1);
			}
			j -= base[i];
			if (j < 0 || j >= MAX_SYMBOLS) message.Error("Invalid bzip data");
			var nextSym = hufGroup.permute[j];
			if (nextSym == SYMBOL_RUNA || nextSym == SYMBOL_RUNB) {
				if (!runPos) {
					runPos = 1;
					t = 0;
				}
				if (nextSym == SYMBOL_RUNA) t += runPos;
				else t += 2 * runPos;
				runPos <<= 1;
				continue;
			}
			if (runPos) {
				runPos = 0;
				if (count + t > bufsize) message.Error("Invalid bzip data");
				uc = this.symToByte[this.mtfSymbol[0]];
				this.byteCount[uc] += t;
				while (t--) buf[count++] = uc;
			}
			if (nextSym > symTotal) break;
			if (count >= bufsize) message.Error("Invalid bzip data");
			i = nextSym - 1;
			uc = this.mtfSymbol[i];
			for (var k = i - 1; k >= 0; k--) this.mtfSymbol[k + 1] = this.mtfSymbol[k];
			this.mtfSymbol[0] = uc;
			uc = this.symToByte[uc];
			this.byteCount[uc]++;
			buf[count++] = uc;
		}
		if (origPtr < 0 || origPtr >= count) message.Error("Invalid bzip data");
		var j = 0;
		for (var i = 0; i < 256; i++) {
			k = j + this.byteCount[i];
			this.byteCount[i] = j;
			j = k;
		}
		for (var i = 0; i < count; i++) {
			uc = buf[i] & 255;
			buf[this.byteCount[uc]] |= i << 8;
			this.byteCount[uc]++;
		}
		var pos = 0, current = 0, run = 0;
		if (count) {
			pos = buf[origPtr];
			current = pos & 255;
			pos >>= 8;
			run = -1;
		}
		count = count;
		var copies, previous, outbyte;
		while (count) {
			count--;
			previous = current;
			pos = buf[pos];
			current = pos & 255;
			pos >>= 8;
			if (run++ == 3) {
				copies = current;
				outbyte = previous;
				current = -1;
			} else {
				copies = 1;
				outbyte = current;
			}
			while (copies--) {
				crc = (crc << 8 ^ this.crcTable[(crc >> 24 ^ outbyte) & 255]) & 4294967295;
				stream(outbyte);
			}
			if (current != previous) run = 0;
		}
		crc = (crc ^ -1) >>> 0;
		if ((crc | 0) != (crcblock | 0)) message.Error("Error in bzip2: crc32 do not match");
		streamCRC = (crc ^ (streamCRC << 1 | streamCRC >>> 31)) & 4294967295;
		return streamCRC;
	};
	bzip2_1 = bzip2;
	return bzip2_1;
}
var bit_iterator;
var hasRequiredBit_iterator;
function requireBit_iterator() {
	if (hasRequiredBit_iterator) return bit_iterator;
	hasRequiredBit_iterator = 1;
	var BITMASK = [
		0,
		1,
		3,
		7,
		15,
		31,
		63,
		127,
		255
	];
	bit_iterator = function bitIterator(nextBuffer) {
		var bit = 0, byte = 0;
		var bytes = nextBuffer();
		var f = function(n) {
			if (n === null && bit != 0) {
				bit = 0;
				byte++;
				return;
			}
			var result = 0;
			while (n > 0) {
				if (byte >= bytes.length) {
					byte = 0;
					bytes = nextBuffer();
				}
				var left = 8 - bit;
				if (bit === 0 && n > 0) f.bytesRead++;
				if (n >= left) {
					result <<= left;
					result |= BITMASK[left] & bytes[byte++];
					bit = 0;
					n -= left;
				} else {
					result <<= n;
					result |= (bytes[byte] & BITMASK[n] << 8 - n - bit) >> 8 - n - bit;
					bit += n;
					n = 0;
				}
			}
			return result;
		};
		f.bytesRead = 0;
		return f;
	};
	return bit_iterator;
}
var unbzip2Stream_1;
var hasRequiredUnbzip2Stream;
function requireUnbzip2Stream() {
	if (hasRequiredUnbzip2Stream) return unbzip2Stream_1;
	hasRequiredUnbzip2Stream = 1;
	const bz2 = requireBzip2();
	const bitIterator = requireBit_iterator();
	unbzip2Stream_1 = unbzip2Stream;
	function unbzip2Stream(input, maxDecompressedBytes = Infinity) {
		const bufferQueue = [];
		let hasBytes = 0;
		let blockSize = 0;
		let broken = false;
		let hasAllData = false;
		let bitReader = null;
		let streamCRC = null;
		let totalOut = 0;
		function decompressBlock(push) {
			if (!blockSize) {
				blockSize = bz2.header(bitReader);
				streamCRC = 0;
				return false;
			} else {
				const bufsize = 1e5 * blockSize;
				const buf = new Int32Array(bufsize);
				let chunk = /* @__PURE__ */ new Uint8Array(32768);
				let chunkLen = 0;
				const f = function(b) {
					if (++totalOut > maxDecompressedBytes) throw new Error("Maximum decompressed size exceeded");
					if (chunkLen === chunk.length) {
						const newLen = Math.min(chunk.length * 2, chunkLen + (maxDecompressedBytes - totalOut) + 1);
						const bigger = new Uint8Array(newLen);
						bigger.set(chunk);
						chunk = bigger;
					}
					chunk[chunkLen++] = b;
				};
				streamCRC = bz2.decompress(bitReader, f, buf, bufsize, streamCRC);
				if (streamCRC === null) {
					blockSize = 0;
					return false;
				} else {
					push(chunk.subarray(0, chunkLen));
					return true;
				}
			}
		}
		let outlength = 0;
		function decompressAndQueue(controller) {
			if (broken) return;
			try {
				return decompressBlock(function(d) {
					controller.enqueue(d);
					if (d !== null) outlength += d.length;
				});
			} catch (e) {
				controller.error(e);
				broken = true;
				return true;
			}
		}
		let inputReader;
		return new ReadableStream({
			start() {
				inputReader = input.getReader();
			},
			async pull(controller) {
				try {
					while (true) {
						while (!(hasAllData || bitReader && hasBytes - bitReader.bytesRead + 1 >= 25e3 + 1e5 * (blockSize || 4))) {
							const { value, done } = await inputReader.read();
							if (!done) {
								bufferQueue.push(value);
								hasBytes += value.length;
								if (bitReader === null) bitReader = bitIterator(function() {
									return bufferQueue.shift();
								});
							} else hasAllData = true;
						}
						while (hasAllData ? bitReader && hasBytes > bitReader.bytesRead : bitReader && hasBytes - bitReader.bytesRead + 1 >= 25e3 + 1e5 * (blockSize || 4)) if (decompressAndQueue(controller)) return;
						if (hasAllData && !broken && (!bitReader || hasBytes <= bitReader.bytesRead)) {
							if (streamCRC === null) controller.close();
							else controller.error(/* @__PURE__ */ new Error("input stream ended prematurely"));
							return;
						}
					}
				} catch (e) {
					controller.error(e);
				}
			},
			async cancel(reason) {
				await inputReader.abort(reason);
			}
		}, { highWaterMark: 0 });
	}
	return unbzip2Stream_1;
}
var unbzip2StreamExports = requireUnbzip2Stream();
var index$1 = /*#__PURE__*/ _mergeNamespaces({
	__proto__: null,
	default: /* @__PURE__ */ getDefaultExportFromCjs(unbzip2StreamExports)
}, [unbzip2StreamExports]);
//#endregion
export { index$1 as i };

//# sourceMappingURL=unbzip2-stream-B1C-JX9L.js.map