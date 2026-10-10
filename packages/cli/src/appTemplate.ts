/*
 * What `ghostly app init` writes (WISP 1200, Apps · Publishing): the smallest app that does something with a contact.
 * Three files, each whole in this module, so the CLI's one built file carries them: the manifest as a publisher writes
 * it, a page that says hello to the same app on the contact's side, and a README with the way from here to a store.
 */

export interface AppTemplate { name: string; title: string }

const html = (text: string) => text.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

/** `ghostly-app.json`: the manifest without `publisher`, `sequence` and `files`, which `app publish` writes. */
export function templateManifest({ name, title }: AppTemplate): Record<string, unknown> {
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
    runtime: { host: ">=1.2", clients: ["web", "desktop"] },
    license: "MIT",
  };
}

/**
 * `index.html`: the whole app in one file, as the sandbox needs it (no network, so nothing is loaded from elsewhere).
 * Its script is plain JavaScript typed with JSDoc against `@ghostlytools/sdk/app`, so it runs as written and still type
 * checks (test/appInit.test.ts does). The title is the only thing put into it, as text. Its type imports are in single
 * quotes: they are text of the page, not imports of the CLI's own build (test/packageDeps.test.ts reads those).
 */
export function templatePage({ title }: AppTemplate): string {
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
</script>
</body>
</html>
`;
}

/** `README.md`: what the folder holds and the way from it to a store. */
export function templateReadme({ name, title }: AppTemplate): string {
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
