import { Co as signAppObject, Dl as toBase64Url, Eo as canonicalJsonBytes, Lc as seedSigner, Ol as toZ32, S as isAppUrl, So as readAppRevocations, Tl as fromBase64Url, To as canonicalJson, _o as checkAppRevokeStatement, a as appStoreDecision, b as assembleAppBundle, d as readAppStore, go as appRef, ho as appFingerprint, m as APP_BUNDLE_LIMITS, mo as APP_STATEMENT_LIMITS, p as signAppStore, po as APP_PREFIXES, u as checkAppStoreIndex, w as readAppBundle, wo as signAppRevocation, x as checkAppManifest } from "./src-dfGE33hw.js";
import { t as CliError } from "./errors-B-zMxbcd.js";
import { closeSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync, writeSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { createHash, createPrivateKey, generateKeyPairSync } from "node:crypto";
//#region src/appTemplate.ts
var html = (text) => text.replace(/[&<>"]/g, (c) => ({
	"&": "&amp;",
	"<": "&lt;",
	">": "&gt;",
	"\"": "&quot;"
})[c]);
/** `ghostly-app.json`: the manifest without `publisher`, `sequence` and `files`, which `app publish` writes. */
function templateManifest({ name, title }) {
	return {
		name,
		version: "0.1.0",
		kind: "mini-app",
		title,
		tagline: "Say hello to a contact",
		description: "Open it in a chat and your contact gets a card to join. Each side can then say hello to the other.",
		entry: "index.html",
		permissions: ["chat"],
		view: "chat",
		runtime: {
			host: ">=1.2",
			clients: ["web", "desktop"]
		},
		license: "MIT"
	};
}
/**
* `index.html`: the whole app in one file, as the sandbox needs it (no network, so nothing is loaded from elsewhere).
* Its script is plain JavaScript typed with JSDoc against `@ghostlytools/sdk/app`, so it runs as written and still type
* checks (test/appInit.test.ts does). The title is the only thing put into it, as text. Its type imports are in single
* quotes: they are text of the page, not imports of the CLI's own build (test/packageDeps.test.ts reads those).
*/
function templatePage({ title }) {
	return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${html(title)}</title>
<style>
  :root { color-scheme: light dark; --bg: #ffffff; --fg: #16181d; --muted: #5b6270; --line: #d9dde3; --accent: #2f6fed; }
  :root[data-theme="dark"] { --bg: #16181d; --fg: #f2f4f7; --muted: #a3abb8; --line: #343a45; --accent: #7aa5ff; }
  body { margin: 0; padding: 20px; background: var(--bg); color: var(--fg); font: 16px/1.4 system-ui, sans-serif; }
  h1 { margin: 0 0 4px; font-size: 20px; }
  #status { margin: 0 0 16px; color: var(--muted); }
  button { font: inherit; padding: 8px 16px; border: 1px solid var(--accent); border-radius: 8px; background: var(--accent); color: var(--bg); }
  button:disabled { opacity: 0.5; }
  ul { margin: 16px 0 0; padding: 0; list-style: none; }
  li { padding: 8px 0; border-top: 1px solid var(--line); }
</style>
</head>
<body>
<h1>${html(title)}</h1>
<p id="status" role="status">Starting</p>
<button id="hello" type="button" disabled>Say hello</button>
<ul id="log" aria-label="Messages"></ul>
<script type="module">
// The types of the API come from the SDK (npm install --save-dev @ghostlytools/sdk); nothing of it runs here.
/** @typedef {import('@ghostlytools/sdk/app').MiniAppApi} MiniAppApi */
/** @typedef {import('@ghostlytools/sdk/app').MiniAppJson} MiniAppJson */

/** The longest text shown from a contact's frame. */
const MAX_TEXT = 200;

const status = /** @type {HTMLElement} */ (document.getElementById("status"));
const button = /** @type {HTMLButtonElement} */ (document.getElementById("hello"));
const log = /** @type {HTMLElement} */ (document.getElementById("log"));

/** @param {string} text */
function show(text) {
  const line = document.createElement("li");
  line.textContent = text;
  log.append(line);
}

/**
 * What the contact's app sent, when it is a hello. A frame comes from another device: read only what this app sends,
 * and never put it in the page as HTML.
 * @param {MiniAppJson} data
 * @returns {string | null}
 */
function helloOf(data) {
  if (!data || typeof data !== "object" || Array.isArray(data) || data.type !== "hello") return null;
  return typeof data.text === "string" && data.text.length <= MAX_TEXT ? data.text : null;
}

/**
 * Why a send was refused, in words. The code is the rejection's message (MINI_APP_ERROR_CODES in the SDK); a later
 * client may add one.
 * @param {unknown} error
 */
function refusal(error) {
  switch (error instanceof Error ? error.message : "") {
    case "offline": return "Not sent: you are not both online";
    case "peer-closed": case "not-open": return "Not sent: your contact has not opened this app";
    case "not-allowed": return "Open this app in a chat to say hello";
    default: return "Not sent";
  }
}

/** @param {MiniAppApi} ghostly */
async function start(ghostly) {
  // Listen before anything is awaited, so no frame is missed.
  ghostly.chat.on("message", (data) => {
    const text = helloOf(data);
    if (text !== null) show("Your contact: " + text);
  });
  ghostly.chat.on("peer", (peer) => {
    status.textContent = peer.open ? "Your contact has this app open" : "Waiting for your contact to open this app";
  });

  const context = await ghostly.context();
  const dark = context.theme ? context.theme === "dark" : matchMedia("(prefers-color-scheme: dark)").matches;
  document.documentElement.dataset.theme = dark ? "dark" : "light";
  status.textContent = !context.inChat ? "Open this app in a chat to say hello"
    : context.peer ? "Your contact has this app open" : "Waiting for your contact to open this app";

  button.disabled = false;
  button.addEventListener("click", async () => {
    try {
      await ghostly.chat.send({ type: "hello", text: "Hello!" });
      show("You: Hello!");
    } catch (error) {
      show(refusal(error));
    }
  });
}

/** Ghostly's runner gives the app \`window.ghostly\`; a browser tab has none. */
const ghostly = /** @type {{ ghostly?: MiniAppApi }} */ (window).ghostly;
if (ghostly) void start(ghostly);
else status.textContent = "This page is a Ghostly app: publish it and open it in Ghostly";
<\/script>
</body>
</html>
`;
}
/** `README.md`: what the folder holds and the way from it to a store. */
function templateReadme({ name, title }) {
	return `# ${title}

A [Ghostly](https://github.com/MiguelMedeiros/ghostly) app, started with \`ghostly app init\`. Opened in a 1:1 chat, it
gives your contact a card to join, and each side can say hello to the other.

A Ghostly app ([WISP 1200](https://github.com/MiguelMedeiros/ghostly/blob/dev/docs/wisps/1200-marketplace.md)) is a
page that runs in the client's sandbox. It has no network, and talks to Ghostly only through \`window.ghostly\`:
frames of at most 32 KiB to the same app on the contact's side (\`chat.send\`, \`chat.on\`), storage per app and per
chat, and the files of its own bundle. Apps run in Ghostly from release 1.2.

| File | What it is |
|---|---|
| \`ghostly-app.json\` | The manifest, without \`publisher\`, \`sequence\` and \`files\`: \`ghostly app publish\` writes those |
| \`index.html\` | The app, whole: styles and script inline |
| \`README.md\` | This file |

## Write it

\`index.html\` is plain JavaScript, typed with JSDoc against \`@ghostlytools/sdk/app\`: \`MiniAppApi\` is
\`window.ghostly\`, and the same module has the limits (\`MINI_APP_LIMITS\`) and the codes a refused call rejects with
(\`MINI_APP_ERROR_CODES\`). For the types in your editor:

\`\`\`sh
npm install --save-dev @ghostlytools/sdk
\`\`\`

- What a contact's app sends is untrusted: check its shape, bound its size, and show it as text, never as HTML.
- \`"view": "chat"\` runs the app inside a chat with one contact. \`"full"\` is a full-screen app opened from the Apps page.
- \`permissions\` lists what the person is asked for: \`chat\` (frames to the contact's app), \`name\` (the person's
  display name) and \`internet\`. Adding one later makes every install ask before it updates.

## Build

There is nothing to build yet: the page is the app. Once it grows into several source files, or TypeScript, build it
into one self-contained \`index.html\` (scripts, styles and images inline) and put that file and \`ghostly-app.json\`
alone in a folder of their own, which is the folder you publish.
[ghostly-chess](https://github.com/MiguelMedeiros/ghostly-chess) does it with Vite and a small
\`scripts/stage.mjs\`. \`ghostly app publish\` takes every file of the folder it is given but dot files, this README
included, so do not run it on a repository with sources, \`node_modules\` or anything private in it.

## Publish

\`\`\`sh
ghostly app publish . --key ~/ghostly-keys/${name}-publisher.key
ghostly app verify app.ghostlyapp
\`\`\`

\`publish\` signs the folder into \`app.ghostlyapp\`. The first run makes the publisher key at the path you name:

- Keep it **outside this folder** and its repository (\`publish\` refuses a key inside it), and never commit it.
- Back it up. An app is updated only with the key that signed it; a lost key means a new app.

\`verify\` checks the bundle as Ghostly will and prints its \`ref\` (\`<publisher key>/${name}\`), \`sequence\` and
\`digest\`. For the next version, raise \`version\` in \`ghostly-app.json\` and publish again: the sequence goes up
by one by itself.

## Try it

Commit \`app.ghostlyapp\` to a public GitHub repository, then in Ghostly open Apps, choose Add, and paste its URL
(\`https://raw.githubusercontent.com/<owner>/<repo>/HEAD/app.ghostlyapp\`). Set \`sources\` in \`ghostly-app.json\`
to that URL, in a list, so installs made from it find your updates. Open the app from a chat's + menu; your contact
gets a card to install and open it.

## List it in a store

A store is a signed list of apps. The official one is a Git repository,
[ghostly-store](https://github.com/MiguelMedeiros/ghostly-store), and apps enter it by pull request:

1. Commit \`app.ghostlyapp\` to your public repository and note that commit.
2. Add \`apps/${name}.<first 16 characters of your publisher key>/listing.json\` with the \`ref\`, \`sequence\`
   and \`digest\` that \`ghostly app verify\` printed. Its \`urls\` start with a jsDelivr URL pinned to the full commit
   (\`https://cdn.jsdelivr.net/gh/<owner>/<repo>@<40-character commit>/app.ghostlyapp\`).
3. Open the pull request. Its check verifies the bundle; a maintainer reviews the app and the owner signs the index.

The store's [CONTRIBUTING](https://github.com/MiguelMedeiros/ghostly-store/blob/main/CONTRIBUTING.md) has the rules.
An app installed from a store updates only to the version that store lists, so each new version is a pull request too.

## If something goes wrong

If a version is harmful, \`ghostly app revoke . --key <your key> --up-to <sequence>\` writes \`ghostly-revoke.json\`;
publish it beside \`app.ghostlyapp\` and Ghostly stops those versions.
`;
}
//#endregion
//#region src/apps.ts
var APP_SOURCE = "ghostly-app.json";
var APP_BUNDLE_FILE = "app.ghostlyapp";
var APP_REVOKE_FILE = "ghostly-revoke.json";
var STORE_INDEX_FILE = "ghostly-store.json";
var STORE_SIG_FILE = "ghostly-store.sig";
/** How long `app verify` waits for a URL, and how many redirects it follows (each checked as the first). */
var FETCH_TIMEOUT_MS = 6e4;
var MAX_REDIRECTS = 5;
var KEY_HEADER = {
	publisher: "Ghostly publisher key (WISP 1200). Secret: never share or commit it. Back it up: an app signed with it is updated only with it.",
	store: "Ghostly store key (WISP 1200). Secret: keep it offline, never share or commit it. Back it up: a store is its key."
};
var PEM = /-----BEGIN PRIVATE KEY-----\r?\n([A-Za-z0-9+/=\r\n]+)-----END PRIVATE KEY-----/;
/** Refuses a key file that is not a plain file of this user's, or that anyone else may read or write. */
function checkKeyFile(path) {
	const info = statSync(path);
	if (!info.isFile()) throw new CliError("bad_request", `${path} is not a file: --key names a key file`);
	if (process.platform === "win32") return;
	if (process.getuid && info.uid !== process.getuid()) throw new CliError("refused", `${path} is not this user's: a key file must be yours alone`);
	if ((info.mode & 63) !== 0) throw new CliError("refused", `${path} may be read by others (mode ${(info.mode & 511).toString(8)}): run chmod 600 ${path}, and think whether the key was seen`);
}
/** Reads a key file: the PEM block, an Ed25519 key, and the kind its first line names (when it names one). */
function readKey(path, kind) {
	checkKeyFile(path);
	const text = readFileSync(path, "utf8");
	const other = kind === "publisher" ? "store" : "publisher";
	if (text.startsWith(`Ghostly ${other} key`)) throw new CliError("refused", `${path} is a ${other} key: ${kind === "publisher" ? "a store key never signs an app" : "a publisher key never signs a store index"} (WISP 1200 · Stores)`);
	const block = PEM.exec(text);
	let seed;
	if (block) try {
		const key = createPrivateKey(block[0]);
		const d = key.asymmetricKeyType === "ed25519" ? key.export({ format: "jwk" }).d : void 0;
		if (d) seed = fromBase64Url(d);
	} catch {}
	if (!seed || seed.length !== 32) throw new CliError("bad_request", `${path} holds no Ed25519 private key (a PEM "PRIVATE KEY" block, as openssl genpkey -algorithm ed25519 writes)`);
	const signer = seedSigner(seed);
	return {
		signer,
		key: toZ32(signer.publicKey),
		created: false
	};
}
/** Makes a key file: owner-only from the start, never over a file that is there. */
function makeKey(path, kind) {
	mkdirSync(dirname(path), {
		recursive: true,
		mode: 448
	});
	const { privateKey } = generateKeyPairSync("ed25519");
	const pem = privateKey.export({
		type: "pkcs8",
		format: "pem"
	});
	const fd = openSync(path, "wx", 384);
	try {
		writeSync(fd, `${KEY_HEADER[kind]}\n${pem}`);
	} finally {
		closeSync(fd);
	}
	return {
		...readKey(path, kind),
		created: true
	};
}
/** What the person is told on stderr when a key was made: where, which, and to back it up. Never the key. */
function madeKeyNote(path, kind, key) {
	return kind === "publisher" ? `new publisher key written to ${path}; back it up (${appFingerprint(key)}: an app is updated only with the key that signed it, and phase 1 has no recovery)` : `new store key written to ${path}; back it up and keep it offline (${appFingerprint(key)}: a store is its key)`;
}
var refused = (what, reading, extra = {}) => new CliError("refused", `${what} (${reading.reason}${reading.detail ? `: ${reading.detail}` : ""})`, {
	reason: reading.reason,
	...reading.detail ? { detail: reading.detail } : {},
	...extra
});
/** A bundle file's bytes: its size is checked before it is read, so a huge file is refused unread. */
function readBundleFile(path) {
	const info = statSync(path);
	if (info.isDirectory()) throw new CliError("bad_request", `${path} is a folder: name a .ghostlyapp file`);
	if (info.size > APP_BUNDLE_LIMITS.bundleBytes) throw refused(`${path} is not a valid bundle`, {
		reason: "too-large",
		detail: `${info.size} bytes`
	});
	return new Uint8Array(readFileSync(path));
}
/**
* A bundle at an https URL, as a client fetches one: `https:` only, no user or password, jsDelivr only at a full
* commit (WISP 1200 · Manifest, "Every URL"); every redirect is held to the same rule, and the download stops past
* 16 MiB.
*/
async function fetchBundle(url) {
	let at = url;
	for (let hop = 0;; hop++) {
		if (!isAppUrl(at)) throw new CliError(hop ? "refused" : "usage", hop ? `${url} redirects to ${at}, which a client does not read (https only, no user or password, jsDelivr only at a full commit)` : `Not a URL a client reads: https only, at most ${APP_BUNDLE_LIMITS.url} characters, no user or password, and jsDelivr only as https://cdn.jsdelivr.net/gh/<owner>/<repo>@<40-hex commit>/<path>`);
		let response;
		try {
			response = await fetch(at, {
				redirect: "manual",
				signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
			});
		} catch (error) {
			if (error instanceof Error && error.name === "TimeoutError") throw new CliError("timeout", `${at} did not answer in ${FETCH_TIMEOUT_MS / 1e3} s`);
			throw new CliError("unavailable", `Could not read ${at}: ${error instanceof Error ? error.message : String(error)}`);
		}
		if (response.status >= 300 && response.status < 400 && response.headers.get("location")) {
			await response.body?.cancel();
			if (hop >= MAX_REDIRECTS) throw new CliError("refused", `${url} redirects more than ${MAX_REDIRECTS} times`);
			at = new URL(response.headers.get("location"), at).href;
			continue;
		}
		if (response.status === 404 || response.status === 410) {
			await response.body?.cancel();
			throw new CliError("not_found", `${at} answered ${response.status}`);
		}
		if (!response.ok || !response.body) {
			await response.body?.cancel();
			throw new CliError("unavailable", `${at} answered ${response.status}`);
		}
		const limit = APP_BUNDLE_LIMITS.bundleBytes;
		const tooLarge = (bytes) => refused(`${url} is not a valid bundle`, {
			reason: "too-large",
			detail: `${bytes} bytes`
		});
		const length = Number(response.headers.get("content-length"));
		if (Number.isFinite(length) && length > limit) {
			await response.body.cancel();
			throw tooLarge(length);
		}
		const chunks = [];
		let total = 0;
		const reader = response.body.getReader();
		try {
			for (;;) {
				const { done, value } = await reader.read();
				if (done) break;
				total += value.length;
				if (total > limit) {
					await reader.cancel();
					throw tooLarge(`more than ${limit}`);
				}
				chunks.push(value);
			}
		} catch (error) {
			if (error instanceof CliError) throw error;
			if (error instanceof Error && error.name === "TimeoutError") throw new CliError("timeout", `${at} did not finish in ${FETCH_TIMEOUT_MS / 1e3} s`);
			throw new CliError("unavailable", `Could not read ${at}: ${error instanceof Error ? error.message : String(error)}`);
		}
		const out = new Uint8Array(total);
		let offset = 0;
		for (const chunk of chunks) {
			out.set(chunk, offset);
			offset += chunk.length;
		}
		return out;
	}
}
/** What a checked bundle is, as `app verify` and `app publish` print it. */
function described(bundle, bytes) {
	const m = bundle.manifest;
	return {
		ref: appRef(m.publisher, m.name),
		publisher: m.publisher,
		fingerprint: appFingerprint(m.publisher),
		name: m.name,
		title: m.title,
		version: m.version,
		sequence: m.sequence,
		digest: bundle.digest,
		bytes: bytes.length,
		sha256: toBase64Url(createHash("sha256").update(bytes).digest())
	};
}
/** `app verify <bundle|url>`: every check a client makes before it stores a bundle (WISP 1200 · Reading a bundle). */
async function verifyApp(source) {
	const { bundle, bytes } = await checkedBundle(source);
	return {
		valid: true,
		...described(bundle, bytes),
		manifest: bundle.manifest
	};
}
/** A bundle from a file or an https URL, with every check of `app verify`; `url` when it came from one. */
async function checkedBundle(source) {
	const isUrl = /^[a-z][a-z0-9+.-]*:\/\//i.test(source);
	const bytes = isUrl ? await fetchBundle(source) : readBundleFile(resolve(source));
	const read = readAppBundle(bytes);
	if (!read.ok) throw refused(`${source} is not a valid bundle`, read);
	return {
		bundle: read.bundle,
		bytes,
		...isUrl && { url: source }
	};
}
/** A folder's name as an app's: lower case, anything else a hyphen (`My App` is `my-app`). */
var nameFrom = (folder) => folder.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
/** An app's name as a title: `my-app` is `My app`. */
var titleFrom = (name) => (name[0].toUpperCase() + name.slice(1)).replace(/-/g, " ");
/**
* `app init <dir> [--name <name>] [--title <title>] [--force]`: a small working app in `<dir>` (made when missing),
* which `app publish <dir>` signs as it is: `ghostly-app.json`, an `index.html` that says hello to the contact, and a
* README with the way to a store (./appTemplate.ts). The name is `--name`, else the folder's; the title `--title`, else
* the name's. Nothing is written when one of the three files is there, unless `--force`, which replaces those three only.
*/
async function initApp(dirArg, what = {}) {
	const usage = "ghostly app init <dir> [--name <name>] [--title <title>] [--force]";
	const dir = resolve(dirArg);
	const name = what.name ?? nameFrom(basename(dir));
	const title = what.title ?? (name ? titleFrom(name) : "");
	const page = templatePage({
		name,
		title
	});
	const pageBytes = new TextEncoder().encode(page);
	const checked = checkAppManifest({
		...templateManifest({
			name,
			title
		}),
		ghostlyApp: 1,
		publisher: toZ32(/* @__PURE__ */ new Uint8Array(32)),
		sequence: 1,
		files: [{
			path: "index.html",
			size: pageBytes.length,
			sha256: toBase64Url(createHash("sha256").update(pageBytes).digest())
		}]
	}, { strict: true });
	if (!checked.ok) {
		if (checked.detail === "name is not valid") throw new CliError("usage", what.name === void 0 ? `The folder's name gives no app name (${JSON.stringify(basename(dir))}): give --name, a lowercase letter then up to 31 lowercase letters, digits or hyphens: ${usage}` : `--name is a lowercase letter then up to 31 lowercase letters, digits or hyphens, not ${JSON.stringify(what.name)}`);
		if (checked.detail === "title is not valid") throw new CliError("usage", `--title is one line of 1 to ${APP_BUNDLE_LIMITS.title} characters, not ${JSON.stringify(title)}`);
		throw refused("The template makes no valid manifest", checked);
	}
	if (existsSync(dir) && !statSync(dir).isDirectory()) throw new CliError("bad_request", `${dir} is a file: name a folder for the app`);
	const files = [
		[APP_SOURCE, `${JSON.stringify(templateManifest({
			name,
			title
		}), null, 2)}\n`],
		["index.html", page],
		["README.md", templateReadme({
			name,
			title
		})]
	];
	const held = files.map(([path]) => path).filter((path) => existsSync(join(dir, path)));
	if (held.length && !what.force) throw refused(`${dir} already holds ${held.join(", ")}: nothing was written (--force replaces ${held.length > 1 ? "them" : "it"})`, { reason: "exists" }, { files: held });
	mkdirSync(dir, { recursive: true });
	for (const [path, text] of files) writeWhole(join(dir, path), new TextEncoder().encode(text));
	return {
		dir,
		name,
		title,
		files: files.map(([path]) => path),
		...held.length ? { replaced: held } : {},
		next: `ghostly app publish ${dirArg} --key <a key file outside ${dirArg}>`
	};
}
/** Every file of the folder, as the bundle names it; dot files and folders are left out and listed. */
function collectFiles(dir, leaveOut) {
	const files = [];
	const skipped = [];
	let bytes = 0;
	const walk = (folder) => {
		for (const name of readdirSync(folder).sort()) {
			const full = join(folder, name);
			const path = relative(dir, full).split(sep).join("/");
			if (leaveOut.has(full)) continue;
			if (name.startsWith(".")) {
				skipped.push(path);
				continue;
			}
			const info = lstatSync(full);
			if (info.isSymbolicLink()) throw new CliError("bad_request", `${path} is a link: a bundle holds the folder's own files (copy it in, or remove it)`);
			if (info.isDirectory()) {
				walk(full);
				continue;
			}
			if (!info.isFile()) throw new CliError("bad_request", `${path} is not a file`);
			files.push({
				path,
				full,
				size: info.size
			});
			bytes += info.size;
			if (files.length > APP_BUNDLE_LIMITS.files) throw refused(`${dir} holds more files than a bundle may`, {
				reason: "too-many-files",
				detail: `more than ${APP_BUNDLE_LIMITS.files}`
			});
			if (bytes > APP_BUNDLE_LIMITS.bundleBytes) throw refused(`${dir} holds more than a bundle may`, {
				reason: "too-large",
				detail: `more than ${APP_BUNDLE_LIMITS.bundleBytes} bytes of files`
			});
		}
	};
	walk(dir);
	files.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
	return {
		files,
		skipped
	};
}
/**
* A private key in a file: a PEM private key block with its body (PKCS #8, OpenSSH, RSA, EC, encrypted), or a Ghostly
* key file's first line. A library that only names the block's header in its code does not match.
*/
var PRIVATE_KEY = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----\r?\n[A-Za-z0-9+/=\r\n:,-]{40,}-----END [A-Z0-9 ]*PRIVATE KEY-----|^Ghostly (publisher|store) key \(WISP 1200\)/;
/** Whether `path` is `dir` or anything under it. */
var isInside = (dir, path) => {
	const rel = relative(dir, path);
	return !rel.startsWith("..") && !isAbsolute(rel);
};
/** Fields of `ghostly-app.json` the command writes itself. */
var WRITTEN = ["publisher", "files"];
function readSource(path) {
	if (!existsSync(path)) throw new CliError("not_found", `No ${APP_SOURCE} in ${dirname(path)}: it holds the manifest's fields (name, version, title, tagline, entry, permissions, runtime, license, ...) but publisher, sequence and files, which publish writes`);
	let value;
	try {
		value = JSON.parse(readFileSync(path, "utf8"));
	} catch (error) {
		throw new CliError("bad_request", `${path} is not JSON: ${error instanceof Error ? error.message : String(error)}`);
	}
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new CliError("bad_request", `${path} is not a JSON object`);
	const draft = value;
	const written = WRITTEN.filter((k) => k in draft);
	if (written.length) throw new CliError("bad_request", `${path} has ${written.join(" and ")}: publish writes ${written.length > 1 ? "them" : "it"} from the key and the folder's files`);
	if (draft.ghostlyApp !== void 0 && draft.ghostlyApp !== 1) throw refused(`${path} is not a manifest this release makes`, {
		reason: "unsupported-format",
		detail: "ghostlyApp is not 1"
	});
	if (draft.sequence !== void 0 && !(Number.isSafeInteger(draft.sequence) && draft.sequence >= 1)) throw new CliError("bad_request", `${path}: sequence is a whole number from 1 (or leave it out: publish raises it by itself)`);
	return draft;
}
/** Writes a file whole or not at all: a reader never sees half a bundle (and a dot file left by a crash is never bundled). */
function writeWhole(path, bytes) {
	const tmp = join(dirname(path), `.${basename(path)}.${process.pid}.tmp`);
	writeFileSync(tmp, bytes);
	renameSync(tmp, path);
}
/**
* `app publish <dir> --key <file> [--out <file>]`: `<dir>/ghostly-app.json` (the manifest without `publisher`,
* `sequence` and `files`) and every other file in `<dir>` become one signed bundle, by default `<dir>/app.ghostlyapp`.
* The sequence is `--sequence` (higher than the bundle already at `--out`'s), else one more than that bundle's (or
* the source's `sequence`, if higher, else 1). The
* key file is made when it is missing and no earlier bundle is there to update.
*/
async function publishApp(dirArg, keyArg, outArg, sequenceArg) {
	if (sequenceArg !== void 0 && !(Number.isSafeInteger(sequenceArg) && sequenceArg >= 1)) throw new CliError("usage", `--sequence takes a whole number from 1, not ${sequenceArg}`);
	const dir = resolve(dirArg);
	if (!statSync(dir).isDirectory()) throw new CliError("bad_request", `${dir} is not a folder`);
	const keyPath = resolve(keyArg);
	if (isInside(dir, keyPath)) throw refused(`${keyPath} is inside ${dir}, which is published: keep the publisher key outside the app's folder (and its repository)`, { reason: "private-key" });
	const out = resolve(outArg ?? join(dir, "app.ghostlyapp"));
	const sourcePath = join(dir, APP_SOURCE);
	const draft = readSource(sourcePath);
	let previous = null;
	if (existsSync(out)) {
		const read = readAppBundle(readBundleFile(out));
		if (!read.ok) throw refused(`${out} is there and is not a valid bundle: move it away, or name another --out`, read);
		previous = read.bundle.manifest;
	}
	let key;
	if (existsSync(keyPath)) key = readKey(keyPath, "publisher");
	else if (previous) throw new CliError("not_found", `No key file ${keyPath}: ${out} is signed by ${appFingerprint(previous.publisher)}, and only that key publishes its next version`);
	else key = makeKey(keyPath, "publisher");
	if (previous && previous.publisher !== key.key) throw refused(`${out} is ${appRef(previous.publisher, previous.name)}, signed by another key (${appFingerprint(previous.publisher)}): a version of an app is signed by its own key`, { reason: "other-app" }, { publisher: previous.publisher });
	if (previous && previous.name !== draft.name) throw refused(`${out} is the app ${JSON.stringify(previous.name)}, not ${JSON.stringify(draft.name)}: name another --out for another app`, { reason: "other-app" });
	if (sequenceArg !== void 0 && previous && sequenceArg <= previous.sequence) throw refused(`--sequence ${sequenceArg} is not higher than the ${previous.sequence} of ${out}: every client refuses a lower one, and the same one with other content is equivocation`, { reason: sequenceArg < previous.sequence ? "rollback" : "equivocation" }, { previous: previous.sequence });
	const sequence = sequenceArg ?? Math.max(previous ? previous.sequence + 1 : 1, draft.sequence ?? 1);
	const { files, skipped } = collectFiles(dir, /* @__PURE__ */ new Set([
		sourcePath,
		out,
		join(dir, APP_REVOKE_FILE)
	]));
	const contents = files.map((f) => ({
		path: f.path,
		bytes: new Uint8Array(readFileSync(f.full))
	}));
	const keyFile = contents.find((f) => PRIVATE_KEY.test(Buffer.from(f.bytes).toString("latin1")));
	if (keyFile) throw refused(`${keyFile.path} in ${dir} holds a private key, and a bundle is public: move it out of the app's folder`, {
		reason: "private-key",
		detail: keyFile.path
	});
	const manifest = {
		...draft,
		ghostlyApp: 1,
		publisher: key.key,
		sequence,
		files: contents.map((f) => ({
			path: f.path,
			size: f.bytes.length,
			sha256: toBase64Url(createHash("sha256").update(f.bytes).digest())
		}))
	};
	const checked = checkAppManifest(JSON.parse(JSON.stringify(manifest)), { strict: true });
	if (!checked.ok) throw refused(`${sourcePath} and the folder's files make no valid manifest`, checked);
	const { bytes: manifestBytes, signature } = await signAppObject(APP_PREFIXES.app, checked.manifest, key.signer);
	const bundle = assembleAppBundle(manifestBytes, canonicalJsonBytes(signature), contents.map((f) => f.bytes));
	const read = readAppBundle(bundle);
	if (!read.ok) throw refused("The bundle made is not valid", read);
	mkdirSync(dirname(out), { recursive: true });
	writeWhole(out, bundle);
	return {
		...described(read.bundle, bundle),
		previous: previous?.sequence ?? null,
		out,
		files: contents.map((f) => f.path),
		...skipped.length ? { skipped } : {},
		keyCreated: key.created,
		...key.created ? { warning: madeKeyNote(keyPath, "publisher", key.key) } : {}
	};
}
/**
* `app revoke <dir> --key <file> (--digest <digest>... | --up-to <sequence>) [--reason <text>] [--bundle <file>]`: a
* `ghostly-revoke/1` statement (WISP 1200 · Publisher keys, Revocation) for the app whose bundle is `<dir>/app.ghostlyapp`
* (or `--bundle`), signed by that app's publisher key and added to `<dir>/ghostly-revoke.json`, which stays canonical.
* The key is never made here: only the key that signed the app may revoke its versions.
*/
async function revokeApp(dirArg, keyArg, what) {
	const dir = resolve(dirArg);
	const bundlePath = resolve(what.bundle ?? join(dir, "app.ghostlyapp"));
	const listPath = join(dir, APP_REVOKE_FILE);
	const usage = "ghostly app revoke <dir> --key <file> (--digest <digest>... | --up-to <sequence>) [--reason <text>]";
	const digests = what.digests ?? [];
	if (digests.length > 0 === (what.upTo !== void 0)) throw new CliError("usage", `Give --digest (again for each) or --up-to, one of the two: ${usage}`);
	if (what.upTo !== void 0 && !(Number.isSafeInteger(what.upTo) && what.upTo >= 1)) throw new CliError("usage", `--up-to takes a sequence, a whole number from 1, not ${what.upTo}`);
	if (!existsSync(bundlePath)) throw new CliError("not_found", `No bundle ${bundlePath}: a revocation names the app of the bundle in <dir> (or --bundle)`);
	const read = readAppBundle(readBundleFile(bundlePath));
	if (!read.ok) throw refused(`${bundlePath} is not a valid bundle`, read);
	const manifest = read.bundle.manifest;
	const ref = appRef(manifest.publisher, manifest.name);
	const keyPath = resolve(keyArg);
	if (!existsSync(keyPath)) throw new CliError("not_found", `No key file ${keyPath}: only the key that signed ${ref} (${appFingerprint(manifest.publisher)}) revokes its versions`);
	const key = readKey(keyPath, "publisher");
	if (key.key !== manifest.publisher) throw refused(`${keyPath} is not the publisher key of ${ref} (${appFingerprint(manifest.publisher)}): a revocation by any other key is refused by every client`, { reason: "signature-key" });
	const statement = digests.length ? {
		ghostlyRevoke: 1,
		app: ref,
		digests
	} : {
		ghostlyRevoke: 1,
		app: ref,
		upTo: what.upTo
	};
	if (what.reason !== void 0) statement.reason = what.reason;
	const problem = checkAppRevokeStatement(statement);
	if (problem) throw refused("Not a revocation a client reads", {
		reason: "bad-revocation",
		detail: problem
	});
	let list = [];
	if (existsSync(listPath)) {
		const held = readAppRevocations(new Uint8Array(readFileSync(listPath)));
		if (!held.ok) throw refused(`${listPath} is there and is not a valid ghostly-revoke.json: fix or move it first`, held);
		list = held.revocations;
	}
	const signed = await signAppRevocation(statement, key.signer);
	const same = list.some((r) => canonicalJson(r.statement) === canonicalJson(signed.statement));
	if (!same) {
		if (list.length >= APP_STATEMENT_LIMITS.revocations) throw refused(`${listPath} holds ${list.length} revocations already`, {
			reason: "bad-revocation",
			detail: `at most ${APP_STATEMENT_LIMITS.revocations}`
		});
		list = [...list, signed];
		const bytes = canonicalJsonBytes(list);
		const check = readAppRevocations(bytes);
		if (!check.ok) throw refused("The revocation list made is not valid", check);
		writeWhole(listPath, bytes);
	}
	return {
		app: ref,
		...digests.length ? {
			digests,
			current: digests.includes(read.bundle.digest)
		} : {
			upTo: what.upTo,
			current: manifest.sequence <= what.upTo
		},
		...what.reason !== void 0 ? { reason: what.reason } : {},
		added: !same,
		revocations: list.length,
		file: listPath
	};
}
/**
* `store sign <index> --key <file> [--out <dir>]`: a store index written by hand (any JSON layout; `key` may be left
* out and is then the signing key's) becomes `ghostly-store.json`, canonical, and `ghostly-store.sig`, in `--out` or
* beside the index. It is read back as a client reads it (`expires` at most 90 days ahead), and refused when the index
* already there, signed by the same key, has a higher `sequence`, or the same one with other content.
*/
async function signStore(indexArg, keyArg, outArg, now = Math.floor(Date.now() / 1e3)) {
	const indexPath = resolve(indexArg);
	const keyPath = resolve(keyArg);
	const outDir = resolve(outArg ?? dirname(indexPath));
	let value;
	try {
		value = JSON.parse(readFileSync(indexPath, "utf8"));
	} catch (error) {
		if (error instanceof SyntaxError) throw new CliError("bad_request", `${indexPath} is not JSON: ${error.message}`);
		throw error;
	}
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new CliError("bad_request", `${indexPath} is not a JSON object`);
	const index = value;
	let key;
	if (existsSync(keyPath)) key = readKey(keyPath, "store");
	else if (index.key !== void 0) throw new CliError("not_found", `No key file ${keyPath}: the index names the store key ${typeof index.key === "string" ? appFingerprint(index.key) : JSON.stringify(index.key)}`);
	else key = makeKey(keyPath, "store");
	if (index.key !== void 0 && index.key !== key.key) throw refused(`${indexPath} names another store key than ${keyPath}'s (${appFingerprint(key.key)})`, { reason: "store-key" });
	index.key = key.key;
	const checked = checkAppStoreIndex(index, { strict: true });
	if (!checked.ok) throw refused(`${indexPath} is not a valid store index`, checked);
	const { indexBytes, sigBytes } = await signAppStore(index, key.signer);
	const read = readAppStore(indexBytes, sigBytes, now, key.key);
	if (!read.ok) throw refused(`${indexPath} would be refused by a client`, read);
	const store = read.store;
	const indexOut = join(outDir, STORE_INDEX_FILE), sigOut = join(outDir, STORE_SIG_FILE);
	let previous = null;
	if (existsSync(indexOut) && existsSync(sigOut)) {
		const held = readAppStore(new Uint8Array(readFileSync(indexOut)), new Uint8Array(readFileSync(sigOut)), now);
		if (held.ok && held.store.index.key === key.key) {
			previous = held.store.index.sequence;
			const decision = appStoreDecision({
				key: key.key,
				sequence: held.store.index.sequence,
				digest: held.store.digest
			}, {
				key: key.key,
				sequence: store.index.sequence,
				digest: store.digest
			});
			if (decision === "rollback" || decision === "equivocation") throw refused(`${indexOut} already holds sequence ${held.store.index.sequence} of this store: ${decision === "rollback" ? "a lower one is refused by every client" : "the same one with other content is refused as equivocation"}; raise sequence`, { reason: decision }, { held: held.store.index.sequence });
		}
	}
	mkdirSync(outDir, { recursive: true });
	writeWhole(indexOut, indexBytes);
	writeWhole(sigOut, sigBytes);
	const notes = [...key.created ? [madeKeyNote(keyPath, "store", key.key)] : [], ...store.expired ? [`expires (${(/* @__PURE__ */ new Date(store.index.expires * 1e3)).toISOString()}) is past: clients still install from it and say the store was not updated since then`] : []];
	return {
		key: key.key,
		fingerprint: appFingerprint(key.key),
		name: store.index.name,
		kind: store.index.kind,
		sequence: store.index.sequence,
		previous,
		expires: store.index.expires,
		expired: store.expired,
		apps: store.index.apps.length,
		removed: store.index.removed.length,
		revoked: store.index.revoked.length,
		digest: store.digest,
		index: indexOut,
		sig: sigOut,
		keyCreated: key.created,
		...notes.length ? { warning: notes.join("; ") } : {}
	};
}
//#endregion
export { STORE_SIG_FILE as a, publishApp as c, verifyApp as d, STORE_INDEX_FILE as i, revokeApp as l, APP_REVOKE_FILE as n, checkedBundle as o, APP_SOURCE as r, initApp as s, APP_BUNDLE_FILE as t, signStore as u };

//# sourceMappingURL=apps-5iqJvG2e.js.map