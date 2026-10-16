//#region ../iroh-web/pkg/ghostly_iroh_web.js
var wasm;
function addHeapObject(obj) {
	if (heap_next === heap.length) heap.push(heap.length + 1);
	const idx = heap_next;
	heap_next = heap[idx];
	heap[idx] = obj;
	return idx;
}
var CLOSURE_DTORS = typeof FinalizationRegistry === "undefined" ? {
	register: () => {},
	unregister: () => {}
} : new FinalizationRegistry((state) => state.dtor(state.a, state.b));
function debugString(val) {
	const type = typeof val;
	if (type == "number" || type == "boolean" || val == null) return `${val}`;
	if (type == "string") return `"${val}"`;
	if (type == "symbol") {
		const description = val.description;
		if (description == null) return "Symbol";
		else return `Symbol(${description})`;
	}
	if (type == "function") {
		const name = val.name;
		if (typeof name == "string" && name.length > 0) return `Function(${name})`;
		else return "Function";
	}
	if (Array.isArray(val)) {
		const length = val.length;
		let debug = "[";
		if (length > 0) debug += debugString(val[0]);
		for (let i = 1; i < length; i++) debug += ", " + debugString(val[i]);
		debug += "]";
		return debug;
	}
	const builtInMatches = /\[object ([^\]]+)\]/.exec(toString.call(val));
	let className;
	if (builtInMatches && builtInMatches.length > 1) className = builtInMatches[1];
	else return toString.call(val);
	if (className == "Object") try {
		return "Object(" + JSON.stringify(val) + ")";
	} catch (_) {
		return "Object";
	}
	if (val instanceof Error) return `${val.name}: ${val.message}\n${val.stack}`;
	return className;
}
function dropObject(idx) {
	if (idx < 132) return;
	heap[idx] = heap_next;
	heap_next = idx;
}
function getArrayU8FromWasm0(ptr, len) {
	ptr = ptr >>> 0;
	return getUint8ArrayMemory0().subarray(ptr / 1, ptr / 1 + len);
}
var cachedDataViewMemory0 = null;
function getDataViewMemory0() {
	if (cachedDataViewMemory0 === null || cachedDataViewMemory0.buffer.detached === true || cachedDataViewMemory0.buffer.detached === void 0 && cachedDataViewMemory0.buffer !== wasm.memory.buffer) cachedDataViewMemory0 = new DataView(wasm.memory.buffer);
	return cachedDataViewMemory0;
}
function getStringFromWasm0(ptr, len) {
	ptr = ptr >>> 0;
	return decodeText(ptr, len);
}
var cachedUint8ArrayMemory0 = null;
function getUint8ArrayMemory0() {
	if (cachedUint8ArrayMemory0 === null || cachedUint8ArrayMemory0.byteLength === 0) cachedUint8ArrayMemory0 = new Uint8Array(wasm.memory.buffer);
	return cachedUint8ArrayMemory0;
}
function getObject(idx) {
	return heap[idx];
}
function handleError(f, args) {
	try {
		return f.apply(this, args);
	} catch (e) {
		wasm.__wbindgen_export3(addHeapObject(e));
	}
}
var heap = new Array(128).fill(void 0);
heap.push(void 0, null, true, false);
var heap_next = heap.length;
function isLikeNone(x) {
	return x === void 0 || x === null;
}
function makeClosure(arg0, arg1, dtor, f) {
	const state = {
		a: arg0,
		b: arg1,
		cnt: 1,
		dtor
	};
	const real = (...args) => {
		state.cnt++;
		try {
			return f(state.a, state.b, ...args);
		} finally {
			real._wbg_cb_unref();
		}
	};
	real._wbg_cb_unref = () => {
		if (--state.cnt === 0) {
			state.dtor(state.a, state.b);
			state.a = 0;
			CLOSURE_DTORS.unregister(state);
		}
	};
	CLOSURE_DTORS.register(real, state, state);
	return real;
}
function makeMutClosure(arg0, arg1, dtor, f) {
	const state = {
		a: arg0,
		b: arg1,
		cnt: 1,
		dtor
	};
	const real = (...args) => {
		state.cnt++;
		const a = state.a;
		state.a = 0;
		try {
			return f(a, state.b, ...args);
		} finally {
			state.a = a;
			real._wbg_cb_unref();
		}
	};
	real._wbg_cb_unref = () => {
		if (--state.cnt === 0) {
			state.dtor(state.a, state.b);
			state.a = 0;
			CLOSURE_DTORS.unregister(state);
		}
	};
	CLOSURE_DTORS.register(real, state, state);
	return real;
}
function passArray8ToWasm0(arg, malloc) {
	const ptr = malloc(arg.length * 1, 1) >>> 0;
	getUint8ArrayMemory0().set(arg, ptr / 1);
	WASM_VECTOR_LEN = arg.length;
	return ptr;
}
function passArrayJsValueToWasm0(array, malloc) {
	const ptr = malloc(array.length * 4, 4) >>> 0;
	const mem = getDataViewMemory0();
	for (let i = 0; i < array.length; i++) mem.setUint32(ptr + 4 * i, addHeapObject(array[i]), true);
	WASM_VECTOR_LEN = array.length;
	return ptr;
}
function passStringToWasm0(arg, malloc, realloc) {
	if (realloc === void 0) {
		const buf = cachedTextEncoder.encode(arg);
		const ptr = malloc(buf.length, 1) >>> 0;
		getUint8ArrayMemory0().subarray(ptr, ptr + buf.length).set(buf);
		WASM_VECTOR_LEN = buf.length;
		return ptr;
	}
	let len = arg.length;
	let ptr = malloc(len, 1) >>> 0;
	const mem = getUint8ArrayMemory0();
	let offset = 0;
	for (; offset < len; offset++) {
		const code = arg.charCodeAt(offset);
		if (code > 127) break;
		mem[ptr + offset] = code;
	}
	if (offset !== len) {
		if (offset !== 0) arg = arg.slice(offset);
		ptr = realloc(ptr, len, len = offset + arg.length * 3, 1) >>> 0;
		const view = getUint8ArrayMemory0().subarray(ptr + offset, ptr + len);
		const ret = cachedTextEncoder.encodeInto(arg, view);
		offset += ret.written;
		ptr = realloc(ptr, len, offset, 1) >>> 0;
	}
	WASM_VECTOR_LEN = offset;
	return ptr;
}
function takeObject(idx) {
	const ret = getObject(idx);
	dropObject(idx);
	return ret;
}
var cachedTextDecoder = new TextDecoder("utf-8", {
	ignoreBOM: true,
	fatal: true
});
cachedTextDecoder.decode();
var MAX_SAFARI_DECODE_BYTES = 2146435072;
var numBytesDecoded = 0;
function decodeText(ptr, len) {
	numBytesDecoded += len;
	if (numBytesDecoded >= MAX_SAFARI_DECODE_BYTES) {
		cachedTextDecoder = new TextDecoder("utf-8", {
			ignoreBOM: true,
			fatal: true
		});
		cachedTextDecoder.decode();
		numBytesDecoded = len;
	}
	return cachedTextDecoder.decode(getUint8ArrayMemory0().subarray(ptr, ptr + len));
}
var cachedTextEncoder = new TextEncoder();
if (!("encodeInto" in cachedTextEncoder)) cachedTextEncoder.encodeInto = function(arg, view) {
	const buf = cachedTextEncoder.encode(arg);
	view.set(buf);
	return {
		read: arg.length,
		written: buf.length
	};
};
var WASM_VECTOR_LEN = 0;
function __wasm_bindgen_func_elem_3292(arg0, arg1) {
	wasm.__wasm_bindgen_func_elem_3292(arg0, arg1);
}
function __wasm_bindgen_func_elem_3635(arg0, arg1) {
	wasm.__wasm_bindgen_func_elem_3635(arg0, arg1);
}
function __wasm_bindgen_func_elem_1637(arg0, arg1, arg2) {
	wasm.__wasm_bindgen_func_elem_1637(arg0, arg1, addHeapObject(arg2));
}
function __wasm_bindgen_func_elem_8949(arg0, arg1, arg2) {
	wasm.__wasm_bindgen_func_elem_8949(arg0, arg1, addHeapObject(arg2));
}
function __wasm_bindgen_func_elem_4181(arg0, arg1, arg2) {
	wasm.__wasm_bindgen_func_elem_4181(arg0, arg1, addHeapObject(arg2));
}
function __wasm_bindgen_func_elem_8897(arg0, arg1) {
	wasm.__wasm_bindgen_func_elem_8897(arg0, arg1);
}
function __wasm_bindgen_func_elem_9032(arg0, arg1, arg2, arg3) {
	wasm.__wasm_bindgen_func_elem_9032(arg0, arg1, addHeapObject(arg2), addHeapObject(arg3));
}
var __wbindgen_enum_BinaryType = ["blob", "arraybuffer"];
var __wbindgen_enum_ReadableStreamType = ["bytes"];
var __wbindgen_enum_RequestCache = [
	"default",
	"no-store",
	"reload",
	"no-cache",
	"force-cache",
	"only-if-cached"
];
var __wbindgen_enum_RequestCredentials = [
	"omit",
	"same-origin",
	"include"
];
var __wbindgen_enum_RequestMode = [
	"same-origin",
	"no-cors",
	"cors",
	"navigate"
];
var IntoUnderlyingByteSourceFinalization = typeof FinalizationRegistry === "undefined" ? {
	register: () => {},
	unregister: () => {}
} : new FinalizationRegistry((ptr) => wasm.__wbg_intounderlyingbytesource_free(ptr >>> 0, 1));
var IntoUnderlyingSinkFinalization = typeof FinalizationRegistry === "undefined" ? {
	register: () => {},
	unregister: () => {}
} : new FinalizationRegistry((ptr) => wasm.__wbg_intounderlyingsink_free(ptr >>> 0, 1));
var IntoUnderlyingSourceFinalization = typeof FinalizationRegistry === "undefined" ? {
	register: () => {},
	unregister: () => {}
} : new FinalizationRegistry((ptr) => wasm.__wbg_intounderlyingsource_free(ptr >>> 0, 1));
var IrohConnFinalization = typeof FinalizationRegistry === "undefined" ? {
	register: () => {},
	unregister: () => {}
} : new FinalizationRegistry((ptr) => wasm.__wbg_irohconn_free(ptr >>> 0, 1));
var IrohNodeFinalization = typeof FinalizationRegistry === "undefined" ? {
	register: () => {},
	unregister: () => {}
} : new FinalizationRegistry((ptr) => wasm.__wbg_irohnode_free(ptr >>> 0, 1));
var IntoUnderlyingByteSource = class {
	__destroy_into_raw() {
		const ptr = this.__wbg_ptr;
		this.__wbg_ptr = 0;
		IntoUnderlyingByteSourceFinalization.unregister(this);
		return ptr;
	}
	free() {
		const ptr = this.__destroy_into_raw();
		wasm.__wbg_intounderlyingbytesource_free(ptr, 0);
	}
	/**
	* @returns {number}
	*/
	get autoAllocateChunkSize() {
		return wasm.intounderlyingbytesource_autoAllocateChunkSize(this.__wbg_ptr) >>> 0;
	}
	/**
	* @param {ReadableByteStreamController} controller
	* @returns {Promise<any>}
	*/
	pull(controller) {
		return takeObject(wasm.intounderlyingbytesource_pull(this.__wbg_ptr, addHeapObject(controller)));
	}
	/**
	* @param {ReadableByteStreamController} controller
	*/
	start(controller) {
		wasm.intounderlyingbytesource_start(this.__wbg_ptr, addHeapObject(controller));
	}
	/**
	* @returns {ReadableStreamType}
	*/
	get type() {
		return __wbindgen_enum_ReadableStreamType[wasm.intounderlyingbytesource_type(this.__wbg_ptr)];
	}
	cancel() {
		const ptr = this.__destroy_into_raw();
		wasm.intounderlyingbytesource_cancel(ptr);
	}
};
if (Symbol.dispose) IntoUnderlyingByteSource.prototype[Symbol.dispose] = IntoUnderlyingByteSource.prototype.free;
var IntoUnderlyingSink = class {
	__destroy_into_raw() {
		const ptr = this.__wbg_ptr;
		this.__wbg_ptr = 0;
		IntoUnderlyingSinkFinalization.unregister(this);
		return ptr;
	}
	free() {
		const ptr = this.__destroy_into_raw();
		wasm.__wbg_intounderlyingsink_free(ptr, 0);
	}
	/**
	* @param {any} reason
	* @returns {Promise<any>}
	*/
	abort(reason) {
		const ptr = this.__destroy_into_raw();
		return takeObject(wasm.intounderlyingsink_abort(ptr, addHeapObject(reason)));
	}
	/**
	* @returns {Promise<any>}
	*/
	close() {
		const ptr = this.__destroy_into_raw();
		return takeObject(wasm.intounderlyingsink_close(ptr));
	}
	/**
	* @param {any} chunk
	* @returns {Promise<any>}
	*/
	write(chunk) {
		return takeObject(wasm.intounderlyingsink_write(this.__wbg_ptr, addHeapObject(chunk)));
	}
};
if (Symbol.dispose) IntoUnderlyingSink.prototype[Symbol.dispose] = IntoUnderlyingSink.prototype.free;
var IntoUnderlyingSource = class {
	__destroy_into_raw() {
		const ptr = this.__wbg_ptr;
		this.__wbg_ptr = 0;
		IntoUnderlyingSourceFinalization.unregister(this);
		return ptr;
	}
	free() {
		const ptr = this.__destroy_into_raw();
		wasm.__wbg_intounderlyingsource_free(ptr, 0);
	}
	/**
	* @param {ReadableStreamDefaultController} controller
	* @returns {Promise<any>}
	*/
	pull(controller) {
		return takeObject(wasm.intounderlyingsource_pull(this.__wbg_ptr, addHeapObject(controller)));
	}
	cancel() {
		const ptr = this.__destroy_into_raw();
		wasm.intounderlyingsource_cancel(ptr);
	}
};
if (Symbol.dispose) IntoUnderlyingSource.prototype[Symbol.dispose] = IntoUnderlyingSource.prototype.free;
/**
* One paired channel: a single bidirectional stream of text frames.
*/
var IrohConn = class IrohConn {
	static __wrap(ptr) {
		ptr = ptr >>> 0;
		const obj = Object.create(IrohConn.prototype);
		obj.__wbg_ptr = ptr;
		IrohConnFinalization.register(obj, obj.__wbg_ptr, obj);
		return obj;
	}
	__destroy_into_raw() {
		const ptr = this.__wbg_ptr;
		this.__wbg_ptr = 0;
		IrohConnFinalization.unregister(this);
		return ptr;
	}
	free() {
		const ptr = this.__destroy_into_raw();
		wasm.__wbg_irohconn_free(ptr, 0);
	}
	/**
	* Round-trip time in milliseconds, as QUIC measures it.
	* @returns {number}
	*/
	rtt() {
		return wasm.irohconn_rtt(this.__wbg_ptr);
	}
	/**
	* The next text frame, or `undefined` once the channel is closed.
	* @returns {Promise<any>}
	*/
	recv() {
		return takeObject(wasm.irohconn_recv(this.__wbg_ptr));
	}
	/**
	* Sends one text frame. Callers serialise sends; a concurrent call fails.
	* @param {string} text
	* @returns {Promise<any>}
	*/
	send(text) {
		const ptr0 = passStringToWasm0(text, wasm.__wbindgen_export, wasm.__wbindgen_export2);
		const len0 = WASM_VECTOR_LEN;
		return takeObject(wasm.irohconn_send(this.__wbg_ptr, ptr0, len0));
	}
	close() {
		wasm.irohconn_close(this.__wbg_ptr);
	}
	/**
	* @returns {any}
	*/
	binding() {
		try {
			const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
			wasm.irohconn_binding(retptr, this.__wbg_ptr);
			var r0 = getDataViewMemory0().getInt32(retptr + 0, true);
			var r1 = getDataViewMemory0().getInt32(retptr + 4, true);
			if (getDataViewMemory0().getInt32(retptr + 8, true)) throw takeObject(r1);
			return takeObject(r0);
		} finally {
			wasm.__wbindgen_add_to_stack_pointer(16);
		}
	}
	/**
	* The contact's endpoint id.
	* @returns {string}
	*/
	remoteId() {
		let deferred1_0;
		let deferred1_1;
		try {
			const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
			wasm.irohconn_remoteId(retptr, this.__wbg_ptr);
			var r0 = getDataViewMemory0().getInt32(retptr + 0, true);
			var r1 = getDataViewMemory0().getInt32(retptr + 4, true);
			deferred1_0 = r0;
			deferred1_1 = r1;
			return getStringFromWasm0(r0, r1);
		} finally {
			wasm.__wbindgen_add_to_stack_pointer(16);
			wasm.__wbindgen_export4(deferred1_0, deferred1_1, 1);
		}
	}
};
if (Symbol.dispose) IrohConn.prototype[Symbol.dispose] = IrohConn.prototype.free;
/**
* One Iroh endpoint for one paired chat, homed on a relay.
*/
var IrohNode = class IrohNode {
	static __wrap(ptr) {
		ptr = ptr >>> 0;
		const obj = Object.create(IrohNode.prototype);
		obj.__wbg_ptr = ptr;
		IrohNodeFinalization.register(obj, obj.__wbg_ptr, obj);
		return obj;
	}
	__destroy_into_raw() {
		const ptr = this.__wbg_ptr;
		this.__wbg_ptr = 0;
		IrohNodeFinalization.unregister(this);
		return ptr;
	}
	free() {
		const ptr = this.__destroy_into_raw();
		wasm.__wbg_irohnode_free(ptr, 0);
	}
	/**
	* @returns {Promise<any>}
	*/
	close() {
		return takeObject(wasm.irohnode_close(this.__wbg_ptr));
	}
	/**
	* Binds an endpoint for a 32-byte seed and waits until it is reachable
	* through the first relay that answers. `relays` is a list of relay URLs.
	* @param {Uint8Array} seed
	* @param {string[]} relays
	* @param {number} online_ms
	* @returns {Promise<any>}
	*/
	static start(seed, relays, online_ms) {
		const ptr0 = passArray8ToWasm0(seed, wasm.__wbindgen_export);
		const len0 = WASM_VECTOR_LEN;
		const ptr1 = passArrayJsValueToWasm0(relays, wasm.__wbindgen_export);
		const len1 = WASM_VECTOR_LEN;
		return takeObject(wasm.irohnode_start(ptr0, len0, ptr1, len1, online_ms));
	}
	/**
	* Resolves with the next incoming connection, or `undefined` once closed.
	* @returns {Promise<any>}
	*/
	accept() {
		return takeObject(wasm.irohnode_accept(this.__wbg_ptr));
	}
	/**
	* `{ id, relay, addresses: [] }`, the same shape the Desktop publishes.
	* @returns {any}
	*/
	address() {
		try {
			const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
			wasm.irohnode_address(retptr, this.__wbg_ptr);
			var r0 = getDataViewMemory0().getInt32(retptr + 0, true);
			var r1 = getDataViewMemory0().getInt32(retptr + 4, true);
			if (getDataViewMemory0().getInt32(retptr + 8, true)) throw takeObject(r1);
			return takeObject(r0);
		} finally {
			wasm.__wbindgen_add_to_stack_pointer(16);
		}
	}
	/**
	* @param {any} descriptor
	* @param {number} timeout_ms
	* @returns {Promise<any>}
	*/
	connect(descriptor, timeout_ms) {
		return takeObject(wasm.irohnode_connect(this.__wbg_ptr, addHeapObject(descriptor), timeout_ms));
	}
};
if (Symbol.dispose) IrohNode.prototype[Symbol.dispose] = IrohNode.prototype.free;
var EXPECTED_RESPONSE_TYPES = /* @__PURE__ */ new Set([
	"basic",
	"cors",
	"default"
]);
async function __wbg_load(module, imports) {
	if (typeof Response === "function" && module instanceof Response) {
		if (typeof WebAssembly.instantiateStreaming === "function") try {
			return await WebAssembly.instantiateStreaming(module, imports);
		} catch (e) {
			if (module.ok && EXPECTED_RESPONSE_TYPES.has(module.type) && module.headers.get("Content-Type") !== "application/wasm") console.warn("`WebAssembly.instantiateStreaming` failed because your server does not serve Wasm with `application/wasm` MIME type. Falling back to `WebAssembly.instantiate` which is slower. Original error:\n", e);
			else throw e;
		}
		const bytes = await module.arrayBuffer();
		return await WebAssembly.instantiate(bytes, imports);
	} else {
		const instance = await WebAssembly.instantiate(module, imports);
		if (instance instanceof WebAssembly.Instance) return {
			instance,
			module
		};
		else return instance;
	}
}
function __wbg_get_imports() {
	const imports = {};
	imports.wbg = {};
	imports.wbg.__wbg_Error_52673b7de5a0ca89 = function(arg0, arg1) {
		return addHeapObject(Error(getStringFromWasm0(arg0, arg1)));
	};
	imports.wbg.__wbg___wbindgen_boolean_get_dea25b33882b895b = function(arg0) {
		const v = getObject(arg0);
		const ret = typeof v === "boolean" ? v : void 0;
		return isLikeNone(ret) ? 16777215 : ret ? 1 : 0;
	};
	imports.wbg.__wbg___wbindgen_debug_string_adfb662ae34724b6 = function(arg0, arg1) {
		const ptr1 = passStringToWasm0(debugString(getObject(arg1)), wasm.__wbindgen_export, wasm.__wbindgen_export2);
		const len1 = WASM_VECTOR_LEN;
		getDataViewMemory0().setInt32(arg0 + 4, len1, true);
		getDataViewMemory0().setInt32(arg0 + 0, ptr1, true);
	};
	imports.wbg.__wbg___wbindgen_is_function_8d400b8b1af978cd = function(arg0) {
		return typeof getObject(arg0) === "function";
	};
	imports.wbg.__wbg___wbindgen_is_object_ce774f3490692386 = function(arg0) {
		const val = getObject(arg0);
		return typeof val === "object" && val !== null;
	};
	imports.wbg.__wbg___wbindgen_is_string_704ef9c8fc131030 = function(arg0) {
		return typeof getObject(arg0) === "string";
	};
	imports.wbg.__wbg___wbindgen_is_undefined_f6b95eab589e0269 = function(arg0) {
		return getObject(arg0) === void 0;
	};
	imports.wbg.__wbg___wbindgen_string_get_a2a31e16edf96e42 = function(arg0, arg1) {
		const obj = getObject(arg1);
		const ret = typeof obj === "string" ? obj : void 0;
		var ptr1 = isLikeNone(ret) ? 0 : passStringToWasm0(ret, wasm.__wbindgen_export, wasm.__wbindgen_export2);
		var len1 = WASM_VECTOR_LEN;
		getDataViewMemory0().setInt32(arg0 + 4, len1, true);
		getDataViewMemory0().setInt32(arg0 + 0, ptr1, true);
	};
	imports.wbg.__wbg___wbindgen_throw_dd24417ed36fc46e = function(arg0, arg1) {
		throw new Error(getStringFromWasm0(arg0, arg1));
	};
	imports.wbg.__wbg__wbg_cb_unref_87dfb5aaa0cbcea7 = function(arg0) {
		getObject(arg0)._wbg_cb_unref();
	};
	imports.wbg.__wbg_abort_07646c894ebbf2bd = function(arg0) {
		getObject(arg0).abort();
	};
	imports.wbg.__wbg_abort_399ecbcfd6ef3c8e = function(arg0, arg1) {
		getObject(arg0).abort(getObject(arg1));
	};
	imports.wbg.__wbg_addEventListener_e792423147a80626 = function() {
		return handleError(function(arg0, arg1, arg2, arg3) {
			getObject(arg0).addEventListener(getStringFromWasm0(arg1, arg2), getObject(arg3));
		}, arguments);
	};
	imports.wbg.__wbg_append_c5cbdf46455cc776 = function() {
		return handleError(function(arg0, arg1, arg2, arg3, arg4) {
			getObject(arg0).append(getStringFromWasm0(arg1, arg2), getStringFromWasm0(arg3, arg4));
		}, arguments);
	};
	imports.wbg.__wbg_body_947b901c33f7fe32 = function(arg0) {
		const ret = getObject(arg0).body;
		return isLikeNone(ret) ? 0 : addHeapObject(ret);
	};
	imports.wbg.__wbg_buffer_6cb2fecb1f253d71 = function(arg0) {
		const ret = getObject(arg0).buffer;
		return addHeapObject(ret);
	};
	imports.wbg.__wbg_byobRequest_f8e3517f5f8ad284 = function(arg0) {
		const ret = getObject(arg0).byobRequest;
		return isLikeNone(ret) ? 0 : addHeapObject(ret);
	};
	imports.wbg.__wbg_byteLength_faa9938885bdeee6 = function(arg0) {
		return getObject(arg0).byteLength;
	};
	imports.wbg.__wbg_byteOffset_3868b6a19ba01dea = function(arg0) {
		return getObject(arg0).byteOffset;
	};
	imports.wbg.__wbg_call_3020136f7a2d6e44 = function() {
		return handleError(function(arg0, arg1, arg2) {
			return addHeapObject(getObject(arg0).call(getObject(arg1), getObject(arg2)));
		}, arguments);
	};
	imports.wbg.__wbg_call_abb4ff46ce38be40 = function() {
		return handleError(function(arg0, arg1) {
			return addHeapObject(getObject(arg0).call(getObject(arg1)));
		}, arguments);
	};
	imports.wbg.__wbg_cancel_a65cf45dca50ba4c = function(arg0) {
		return addHeapObject(getObject(arg0).cancel());
	};
	imports.wbg.__wbg_catch_b9db41d97d42bd02 = function(arg0, arg1) {
		return addHeapObject(getObject(arg0).catch(getObject(arg1)));
	};
	imports.wbg.__wbg_clearTimeout_3b5c565a5ec539dd = function(arg0) {
		return addHeapObject(clearTimeout(takeObject(arg0)));
	};
	imports.wbg.__wbg_clearTimeout_5e42188b495715bb = function() {
		return handleError(function(arg0, arg1) {
			getObject(arg0).clearTimeout(takeObject(arg1));
		}, arguments);
	};
	imports.wbg.__wbg_close_0af5661bf3d335f2 = function() {
		return handleError(function(arg0) {
			getObject(arg0).close();
		}, arguments);
	};
	imports.wbg.__wbg_close_1db3952de1b5b1cf = function() {
		return handleError(function(arg0) {
			getObject(arg0).close();
		}, arguments);
	};
	imports.wbg.__wbg_close_3ec111e7b23d94d8 = function() {
		return handleError(function(arg0) {
			getObject(arg0).close();
		}, arguments);
	};
	imports.wbg.__wbg_code_85a811fe6ca962be = function(arg0) {
		return getObject(arg0).code;
	};
	imports.wbg.__wbg_code_c2a85f2863ec11b3 = function(arg0) {
		return getObject(arg0).code;
	};
	imports.wbg.__wbg_crypto_86f2631e91b51511 = function(arg0) {
		const ret = getObject(arg0).crypto;
		return addHeapObject(ret);
	};
	imports.wbg.__wbg_data_8bf4ae669a78a688 = function(arg0) {
		const ret = getObject(arg0).data;
		return addHeapObject(ret);
	};
	imports.wbg.__wbg_done_62ea16af4ce34b24 = function(arg0) {
		return getObject(arg0).done;
	};
	imports.wbg.__wbg_enqueue_a7e6b1ee87963aad = function() {
		return handleError(function(arg0, arg1) {
			getObject(arg0).enqueue(getObject(arg1));
		}, arguments);
	};
	imports.wbg.__wbg_entries_13da0847a5239578 = function(arg0) {
		return addHeapObject(getObject(arg0).entries());
	};
	imports.wbg.__wbg_fetch_16dcf1cfbbc66b3c = function(arg0) {
		return addHeapObject(fetch(getObject(arg0)));
	};
	imports.wbg.__wbg_fetch_90447c28cc0b095e = function(arg0, arg1) {
		return addHeapObject(getObject(arg0).fetch(getObject(arg1)));
	};
	imports.wbg.__wbg_getRandomValues_a8ddca022803a145 = function() {
		return handleError(function(arg0, arg1) {
			globalThis.crypto.getRandomValues(getArrayU8FromWasm0(arg0, arg1));
		}, arguments);
	};
	imports.wbg.__wbg_getRandomValues_b3f15fcbfabb0f8b = function() {
		return handleError(function(arg0, arg1) {
			getObject(arg0).getRandomValues(getObject(arg1));
		}, arguments);
	};
	imports.wbg.__wbg_getReader_48e00749fe3f6089 = function() {
		return handleError(function(arg0) {
			return addHeapObject(getObject(arg0).getReader());
		}, arguments);
	};
	imports.wbg.__wbg_get_6b7bd52aca3f9671 = function(arg0, arg1) {
		const ret = getObject(arg0)[arg1 >>> 0];
		return addHeapObject(ret);
	};
	imports.wbg.__wbg_get_af9dab7e9603ea93 = function() {
		return handleError(function(arg0, arg1) {
			return addHeapObject(Reflect.get(getObject(arg0), getObject(arg1)));
		}, arguments);
	};
	imports.wbg.__wbg_get_done_f98a6e62c4e18fb9 = function(arg0) {
		const ret = getObject(arg0).done;
		return isLikeNone(ret) ? 16777215 : ret ? 1 : 0;
	};
	imports.wbg.__wbg_get_value_63e39884ef11812e = function(arg0) {
		const ret = getObject(arg0).value;
		return addHeapObject(ret);
	};
	imports.wbg.__wbg_has_0e670569d65d3a45 = function() {
		return handleError(function(arg0, arg1) {
			return Reflect.has(getObject(arg0), getObject(arg1));
		}, arguments);
	};
	imports.wbg.__wbg_headers_654c30e1bcccc552 = function(arg0) {
		const ret = getObject(arg0).headers;
		return addHeapObject(ret);
	};
	imports.wbg.__wbg_instanceof_ArrayBuffer_f3320d2419cd0355 = function(arg0) {
		let result;
		try {
			result = getObject(arg0) instanceof ArrayBuffer;
		} catch (_) {
			result = false;
		}
		return result;
	};
	imports.wbg.__wbg_instanceof_Blob_e9c51ce33a4b6181 = function(arg0) {
		let result;
		try {
			result = getObject(arg0) instanceof Blob;
		} catch (_) {
			result = false;
		}
		return result;
	};
	imports.wbg.__wbg_instanceof_Response_cd74d1c2ac92cb0b = function(arg0) {
		let result;
		try {
			result = getObject(arg0) instanceof Response;
		} catch (_) {
			result = false;
		}
		return result;
	};
	imports.wbg.__wbg_irohconn_new = function(arg0) {
		return addHeapObject(IrohConn.__wrap(arg0));
	};
	imports.wbg.__wbg_irohnode_new = function(arg0) {
		return addHeapObject(IrohNode.__wrap(arg0));
	};
	imports.wbg.__wbg_isArray_51fd9e6422c0a395 = function(arg0) {
		return Array.isArray(getObject(arg0));
	};
	imports.wbg.__wbg_length_22ac23eaec9d8053 = function(arg0) {
		return getObject(arg0).length;
	};
	imports.wbg.__wbg_message_a4e9a39ee8f92b17 = function(arg0, arg1) {
		const ret = getObject(arg1).message;
		const ptr1 = passStringToWasm0(ret, wasm.__wbindgen_export, wasm.__wbindgen_export2);
		const len1 = WASM_VECTOR_LEN;
		getDataViewMemory0().setInt32(arg0 + 4, len1, true);
		getDataViewMemory0().setInt32(arg0 + 0, ptr1, true);
	};
	imports.wbg.__wbg_msCrypto_d562bbe83e0d4b91 = function(arg0) {
		const ret = getObject(arg0).msCrypto;
		return addHeapObject(ret);
	};
	imports.wbg.__wbg_new_1ba21ce319a06297 = function() {
		return addHeapObject(/* @__PURE__ */ new Object());
	};
	imports.wbg.__wbg_new_25f239778d6112b9 = function() {
		return addHeapObject(new Array());
	};
	imports.wbg.__wbg_new_3c79b3bb1b32b7d3 = function() {
		return handleError(function() {
			return addHeapObject(new Headers());
		}, arguments);
	};
	imports.wbg.__wbg_new_6421f6084cc5bc5a = function(arg0) {
		return addHeapObject(new Uint8Array(getObject(arg0)));
	};
	imports.wbg.__wbg_new_7c30d1f874652e62 = function() {
		return handleError(function(arg0, arg1) {
			return addHeapObject(new WebSocket(getStringFromWasm0(arg0, arg1)));
		}, arguments);
	};
	imports.wbg.__wbg_new_881a222c65f168fc = function() {
		return handleError(function() {
			return addHeapObject(new AbortController());
		}, arguments);
	};
	imports.wbg.__wbg_new_df1173567d5ff028 = function(arg0, arg1) {
		return addHeapObject(new Error(getStringFromWasm0(arg0, arg1)));
	};
	imports.wbg.__wbg_new_ff12d2b041fb48f1 = function(arg0, arg1) {
		try {
			var state0 = {
				a: arg0,
				b: arg1
			};
			var cb0 = (arg0, arg1) => {
				const a = state0.a;
				state0.a = 0;
				try {
					return __wasm_bindgen_func_elem_9032(a, state0.b, arg0, arg1);
				} finally {
					state0.a = a;
				}
			};
			return addHeapObject(new Promise(cb0));
		} finally {
			state0.a = state0.b = 0;
		}
	};
	imports.wbg.__wbg_new_from_slice_f9c22b9153b26992 = function(arg0, arg1) {
		return addHeapObject(new Uint8Array(getArrayU8FromWasm0(arg0, arg1)));
	};
	imports.wbg.__wbg_new_no_args_cb138f77cf6151ee = function(arg0, arg1) {
		return addHeapObject(new Function(getStringFromWasm0(arg0, arg1)));
	};
	imports.wbg.__wbg_new_with_byte_offset_and_length_d85c3da1fd8df149 = function(arg0, arg1, arg2) {
		return addHeapObject(new Uint8Array(getObject(arg0), arg1 >>> 0, arg2 >>> 0));
	};
	imports.wbg.__wbg_new_with_length_aa5eaf41d35235e5 = function(arg0) {
		return addHeapObject(new Uint8Array(arg0 >>> 0));
	};
	imports.wbg.__wbg_new_with_str_and_init_c5748f76f5108934 = function() {
		return handleError(function(arg0, arg1, arg2) {
			return addHeapObject(new Request(getStringFromWasm0(arg0, arg1), getObject(arg2)));
		}, arguments);
	};
	imports.wbg.__wbg_new_with_str_sequence_073466a4a5387941 = function() {
		return handleError(function(arg0, arg1, arg2) {
			return addHeapObject(new WebSocket(getStringFromWasm0(arg0, arg1), getObject(arg2)));
		}, arguments);
	};
	imports.wbg.__wbg_next_3cfe5c0fe2a4cc53 = function() {
		return handleError(function(arg0) {
			return addHeapObject(getObject(arg0).next());
		}, arguments);
	};
	imports.wbg.__wbg_node_e1f24f89a7336c2e = function(arg0) {
		const ret = getObject(arg0).node;
		return addHeapObject(ret);
	};
	imports.wbg.__wbg_now_2c95c9de01293173 = function(arg0) {
		return getObject(arg0).now();
	};
	imports.wbg.__wbg_now_69d776cd24f5215b = function() {
		return Date.now();
	};
	imports.wbg.__wbg_parse_a09a54cf72639456 = function() {
		return handleError(function(arg0, arg1) {
			return addHeapObject(JSON.parse(getStringFromWasm0(arg0, arg1)));
		}, arguments);
	};
	imports.wbg.__wbg_performance_7a3ffd0b17f663ad = function(arg0) {
		const ret = getObject(arg0).performance;
		return addHeapObject(ret);
	};
	imports.wbg.__wbg_process_3975fd6c72f520aa = function(arg0) {
		const ret = getObject(arg0).process;
		return addHeapObject(ret);
	};
	imports.wbg.__wbg_protocol_a74f36816d507cab = function(arg0, arg1) {
		const ret = getObject(arg1).protocol;
		const ptr1 = passStringToWasm0(ret, wasm.__wbindgen_export, wasm.__wbindgen_export2);
		const len1 = WASM_VECTOR_LEN;
		getDataViewMemory0().setInt32(arg0 + 4, len1, true);
		getDataViewMemory0().setInt32(arg0 + 0, ptr1, true);
	};
	imports.wbg.__wbg_prototypesetcall_dfe9b766cdc1f1fd = function(arg0, arg1, arg2) {
		Uint8Array.prototype.set.call(getArrayU8FromWasm0(arg0, arg1), getObject(arg2));
	};
	imports.wbg.__wbg_push_7d9be8f38fc13975 = function(arg0, arg1) {
		return getObject(arg0).push(getObject(arg1));
	};
	imports.wbg.__wbg_queueMicrotask_9b549dfce8865860 = function(arg0) {
		const ret = getObject(arg0).queueMicrotask;
		return addHeapObject(ret);
	};
	imports.wbg.__wbg_queueMicrotask_fca69f5bfad613a5 = function(arg0) {
		queueMicrotask(getObject(arg0));
	};
	imports.wbg.__wbg_randomFillSync_f8c153b79f285817 = function() {
		return handleError(function(arg0, arg1) {
			getObject(arg0).randomFillSync(takeObject(arg1));
		}, arguments);
	};
	imports.wbg.__wbg_read_39c4b35efcd03c25 = function(arg0) {
		return addHeapObject(getObject(arg0).read());
	};
	imports.wbg.__wbg_readyState_9d0976dcad561aa9 = function(arg0) {
		return getObject(arg0).readyState;
	};
	imports.wbg.__wbg_reason_d4eb9e40592438c2 = function(arg0, arg1) {
		const ret = getObject(arg1).reason;
		const ptr1 = passStringToWasm0(ret, wasm.__wbindgen_export, wasm.__wbindgen_export2);
		const len1 = WASM_VECTOR_LEN;
		getDataViewMemory0().setInt32(arg0 + 4, len1, true);
		getDataViewMemory0().setInt32(arg0 + 0, ptr1, true);
	};
	imports.wbg.__wbg_releaseLock_a5912f590b185180 = function(arg0) {
		getObject(arg0).releaseLock();
	};
	imports.wbg.__wbg_removeEventListener_54bf92f4a849bd7d = function() {
		return handleError(function(arg0, arg1, arg2, arg3) {
			getObject(arg0).removeEventListener(getStringFromWasm0(arg1, arg2), getObject(arg3));
		}, arguments);
	};
	imports.wbg.__wbg_require_b74f47fc2d022fd6 = function() {
		return handleError(function() {
			const ret = module.require;
			return addHeapObject(ret);
		}, arguments);
	};
	imports.wbg.__wbg_resolve_fd5bfbaa4ce36e1e = function(arg0) {
		return addHeapObject(Promise.resolve(getObject(arg0)));
	};
	imports.wbg.__wbg_respond_9f7fc54636c4a3af = function() {
		return handleError(function(arg0, arg1) {
			getObject(arg0).respond(arg1 >>> 0);
		}, arguments);
	};
	imports.wbg.__wbg_send_7cc36bb628044281 = function() {
		return handleError(function(arg0, arg1, arg2) {
			getObject(arg0).send(getStringFromWasm0(arg1, arg2));
		}, arguments);
	};
	imports.wbg.__wbg_send_ea59e150ab5ebe08 = function() {
		return handleError(function(arg0, arg1, arg2) {
			getObject(arg0).send(getArrayU8FromWasm0(arg1, arg2));
		}, arguments);
	};
	imports.wbg.__wbg_setTimeout_2b111259203a2623 = function() {
		return handleError(function(arg0, arg1, arg2) {
			return addHeapObject(getObject(arg0).setTimeout(takeObject(arg1), arg2));
		}, arguments);
	};
	imports.wbg.__wbg_setTimeout_cb2a856ba8315e7a = function(arg0, arg1) {
		return addHeapObject(setTimeout(getObject(arg0), arg1));
	};
	imports.wbg.__wbg_set_169e13b608078b7b = function(arg0, arg1, arg2) {
		getObject(arg0).set(getArrayU8FromWasm0(arg1, arg2));
	};
	imports.wbg.__wbg_set_binaryType_73e8c75df97825f8 = function(arg0, arg1) {
		getObject(arg0).binaryType = __wbindgen_enum_BinaryType[arg1];
	};
	imports.wbg.__wbg_set_body_8e743242d6076a4f = function(arg0, arg1) {
		getObject(arg0).body = getObject(arg1);
	};
	imports.wbg.__wbg_set_cache_0e437c7c8e838b9b = function(arg0, arg1) {
		getObject(arg0).cache = __wbindgen_enum_RequestCache[arg1];
	};
	imports.wbg.__wbg_set_credentials_55ae7c3c106fd5be = function(arg0, arg1) {
		getObject(arg0).credentials = __wbindgen_enum_RequestCredentials[arg1];
	};
	imports.wbg.__wbg_set_handle_event_14baa3949ef6909d = function(arg0, arg1) {
		getObject(arg0).handleEvent = getObject(arg1);
	};
	imports.wbg.__wbg_set_headers_5671cf088e114d2b = function(arg0, arg1) {
		getObject(arg0).headers = getObject(arg1);
	};
	imports.wbg.__wbg_set_method_76c69e41b3570627 = function(arg0, arg1, arg2) {
		getObject(arg0).method = getStringFromWasm0(arg1, arg2);
	};
	imports.wbg.__wbg_set_mode_611016a6818fc690 = function(arg0, arg1) {
		getObject(arg0).mode = __wbindgen_enum_RequestMode[arg1];
	};
	imports.wbg.__wbg_set_onclose_032729b3d7ed7a9e = function(arg0, arg1) {
		getObject(arg0).onclose = getObject(arg1);
	};
	imports.wbg.__wbg_set_onerror_7819daa6af176ddb = function(arg0, arg1) {
		getObject(arg0).onerror = getObject(arg1);
	};
	imports.wbg.__wbg_set_onmessage_71321d0bed69856c = function(arg0, arg1) {
		getObject(arg0).onmessage = getObject(arg1);
	};
	imports.wbg.__wbg_set_onopen_6d4abedb27ba5656 = function(arg0, arg1) {
		getObject(arg0).onopen = getObject(arg1);
	};
	imports.wbg.__wbg_set_signal_e89be862d0091009 = function(arg0, arg1) {
		getObject(arg0).signal = getObject(arg1);
	};
	imports.wbg.__wbg_signal_3c14fbdc89694b39 = function(arg0) {
		const ret = getObject(arg0).signal;
		return addHeapObject(ret);
	};
	imports.wbg.__wbg_static_accessor_GLOBAL_769e6b65d6557335 = function() {
		const ret = typeof global === "undefined" ? null : global;
		return isLikeNone(ret) ? 0 : addHeapObject(ret);
	};
	imports.wbg.__wbg_static_accessor_GLOBAL_THIS_60cf02db4de8e1c1 = function() {
		const ret = typeof globalThis === "undefined" ? null : globalThis;
		return isLikeNone(ret) ? 0 : addHeapObject(ret);
	};
	imports.wbg.__wbg_static_accessor_SELF_08f5a74c69739274 = function() {
		const ret = typeof self === "undefined" ? null : self;
		return isLikeNone(ret) ? 0 : addHeapObject(ret);
	};
	imports.wbg.__wbg_static_accessor_WINDOW_a8924b26aa92d024 = function() {
		const ret = typeof window === "undefined" ? null : window;
		return isLikeNone(ret) ? 0 : addHeapObject(ret);
	};
	imports.wbg.__wbg_status_9bfc680efca4bdfd = function(arg0) {
		return getObject(arg0).status;
	};
	imports.wbg.__wbg_stringify_655a6390e1f5eb6b = function() {
		return handleError(function(arg0) {
			return addHeapObject(JSON.stringify(getObject(arg0)));
		}, arguments);
	};
	imports.wbg.__wbg_subarray_845f2f5bce7d061a = function(arg0, arg1, arg2) {
		return addHeapObject(getObject(arg0).subarray(arg1 >>> 0, arg2 >>> 0));
	};
	imports.wbg.__wbg_then_429f7caf1026411d = function(arg0, arg1, arg2) {
		return addHeapObject(getObject(arg0).then(getObject(arg1), getObject(arg2)));
	};
	imports.wbg.__wbg_then_4f95312d68691235 = function(arg0, arg1) {
		return addHeapObject(getObject(arg0).then(getObject(arg1)));
	};
	imports.wbg.__wbg_url_b6d11838a4f95198 = function(arg0, arg1) {
		const ret = getObject(arg1).url;
		const ptr1 = passStringToWasm0(ret, wasm.__wbindgen_export, wasm.__wbindgen_export2);
		const len1 = WASM_VECTOR_LEN;
		getDataViewMemory0().setInt32(arg0 + 4, len1, true);
		getDataViewMemory0().setInt32(arg0 + 0, ptr1, true);
	};
	imports.wbg.__wbg_url_df28eef824b04410 = function(arg0, arg1) {
		const ret = getObject(arg1).url;
		const ptr1 = passStringToWasm0(ret, wasm.__wbindgen_export, wasm.__wbindgen_export2);
		const len1 = WASM_VECTOR_LEN;
		getDataViewMemory0().setInt32(arg0 + 4, len1, true);
		getDataViewMemory0().setInt32(arg0 + 0, ptr1, true);
	};
	imports.wbg.__wbg_value_57b7b035e117f7ee = function(arg0) {
		const ret = getObject(arg0).value;
		return addHeapObject(ret);
	};
	imports.wbg.__wbg_versions_4e31226f5e8dc909 = function(arg0) {
		const ret = getObject(arg0).versions;
		return addHeapObject(ret);
	};
	imports.wbg.__wbg_view_788aaf149deefd2f = function(arg0) {
		const ret = getObject(arg0).view;
		return isLikeNone(ret) ? 0 : addHeapObject(ret);
	};
	imports.wbg.__wbg_wasClean_4154a2d59fdb4dd7 = function(arg0) {
		return getObject(arg0).wasClean;
	};
	imports.wbg.__wbindgen_cast_16e2773336b2d687 = function(arg0, arg1) {
		return addHeapObject(makeMutClosure(arg0, arg1, wasm.__wasm_bindgen_func_elem_1135, __wasm_bindgen_func_elem_1637));
	};
	imports.wbg.__wbindgen_cast_2241b6af4c4b2941 = function(arg0, arg1) {
		return addHeapObject(getStringFromWasm0(arg0, arg1));
	};
	imports.wbg.__wbindgen_cast_467eda6bdea4bc38 = function(arg0, arg1) {
		return addHeapObject(makeMutClosure(arg0, arg1, wasm.__wasm_bindgen_func_elem_8940, __wasm_bindgen_func_elem_8949));
	};
	imports.wbg.__wbindgen_cast_8107477189a212c0 = function(arg0, arg1) {
		return addHeapObject(makeMutClosure(arg0, arg1, wasm.__wasm_bindgen_func_elem_3277, __wasm_bindgen_func_elem_3292));
	};
	imports.wbg.__wbindgen_cast_a724fac821e668fe = function(arg0, arg1) {
		return addHeapObject(makeClosure(arg0, arg1, wasm.__wasm_bindgen_func_elem_3619, __wasm_bindgen_func_elem_3635));
	};
	imports.wbg.__wbindgen_cast_c6a557b04b57c6c0 = function(arg0, arg1) {
		return addHeapObject(makeMutClosure(arg0, arg1, wasm.__wasm_bindgen_func_elem_4149, __wasm_bindgen_func_elem_4181));
	};
	imports.wbg.__wbindgen_cast_cb9088102bce6b30 = function(arg0, arg1) {
		return addHeapObject(getArrayU8FromWasm0(arg0, arg1));
	};
	imports.wbg.__wbindgen_cast_e6d515b161eabad7 = function(arg0, arg1) {
		return addHeapObject(makeMutClosure(arg0, arg1, wasm.__wasm_bindgen_func_elem_8892, __wasm_bindgen_func_elem_8897));
	};
	imports.wbg.__wbindgen_object_clone_ref = function(arg0) {
		return addHeapObject(getObject(arg0));
	};
	imports.wbg.__wbindgen_object_drop_ref = function(arg0) {
		takeObject(arg0);
	};
	return imports;
}
function __wbg_finalize_init(instance, module) {
	wasm = instance.exports;
	__wbg_init.__wbindgen_wasm_module = module;
	cachedDataViewMemory0 = null;
	cachedUint8ArrayMemory0 = null;
	return wasm;
}
function initSync(module) {
	if (wasm !== void 0) return wasm;
	if (typeof module !== "undefined") {
		if (Object.getPrototypeOf(module) === Object.prototype) ({module} = module);
		else console.warn("using deprecated parameters for `initSync()`; pass a single object instead");
	}
	const imports = __wbg_get_imports();
	if (!(module instanceof WebAssembly.Module)) module = new WebAssembly.Module(module);
	return __wbg_finalize_init(new WebAssembly.Instance(module, imports), module);
}
async function __wbg_init(module_or_path) {
	if (wasm !== void 0) return wasm;
	if (typeof module_or_path !== "undefined") {
		if (Object.getPrototypeOf(module_or_path) === Object.prototype) ({module_or_path} = module_or_path);
		else console.warn("using deprecated parameters for the initialization function; pass a single object instead");
	}
	if (typeof module_or_path === "undefined") module_or_path = new URL("ghostly_iroh_web_bg.wasm", import.meta.url);
	const imports = __wbg_get_imports();
	if (typeof module_or_path === "string" || typeof Request === "function" && module_or_path instanceof Request || typeof URL === "function" && module_or_path instanceof URL) module_or_path = fetch(module_or_path);
	const { instance, module } = await __wbg_load(await module_or_path, imports);
	return __wbg_finalize_init(instance, module);
}
//#endregion
export { IntoUnderlyingByteSource, IntoUnderlyingSink, IntoUnderlyingSource, IrohConn, IrohNode, __wbg_init as default, initSync };

//# sourceMappingURL=ghostly_iroh_web-BsAEFIjl.js.map