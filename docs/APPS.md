# Apps: the official store

Ghostly 1.2 installs mini-apps, such as Chess, that run in a sandbox and can play with a contact in a chat. The format,
the signatures and the sandbox are [WISP 1200](wisps/1200-marketplace.md). This page is about the store Ghostly
preloads, and how an app gets into it.

Apps are behind a flag on `dev` and are not in a release yet.

## How the official store works

- **It is a Git repository:** [github.com/MiguelMedeiros/ghostly-store](https://github.com/MiguelMedeiros/ghostly-store).
  There is no server. Ghostly reads one file from it, `ghostly-store.json`, with its signature `ghostly-store.sig`,
  from `https://raw.githubusercontent.com/MiguelMedeiros/ghostly-store/HEAD/ghostly-store.json`.
- **It is pinned to a key.** The client holds the store's public key and refuses an index signed by any other key, an
  older `sequence` than the one it holds, or two indexes with one `sequence`. The owner signs the index offline, so a
  stolen GitHub account cannot change what the store lists.
- **It lists, it does not sign apps.** Each app is signed by its own publisher key. Ghostly checks every bundle against
  that key wherever it was downloaded from, so the store cannot change an app's code. Chess is signed by a publisher key
  of its own, never by the store key.
- **It is curated.** Apps enter by pull request. CI checks each listing and bundle with the Ghostly CLI, a maintainer
  reviews the app, and the owner signs the next index. The review rules and takedowns are in the store's
  [README](https://github.com/MiguelMedeiros/ghostly-store#review-rules).
- **Its apps update to what it reviewed.** An app installed from a store updates only to the version (sequence and
  digest) that store's signed index lists. A newer version pushed to the publisher's repository waits until the store
  lists it. An app added by URL or from a chat card still takes a newer version from its `sources`.
- **It is one store among many.** People can remove it, add other stores by URL, or install an app from its URL or a
  chat card. The default store has no power the others lack.
- **It makes no request by itself.** A profile with no app installed never reads it. It is read when the person opens
  the Apps page, and once an app is installed, at start and every 24 hours.

In the code the store is `DEFAULT_STORE_URL` and `DEFAULT_STORE_KEY` in
[`packages/browser/src/engine/appDefaults.ts`](../packages/browser/src/engine/appDefaults.ts). **While
`DEFAULT_STORE_KEY` is empty the default store is off**: a new profile starts with no store. It stays empty until the
owner makes the key and signs the first index.

## Starting an app

```sh
ghostly app init my-app                       # my-app/ghostly-app.json, index.html, README.md
ghostly app publish my-app --key ~/ghostly-keys/my-app-publisher.key
ghostly app verify my-app/app.ghostlyapp
```

`app init` writes a small working app: opened in a 1:1 chat, each side can say hello to the other. Its `index.html` is
the whole app, plain JavaScript typed against [`@ghostlytools/sdk/app`](SDK.md), and its README has the steps from
there to a store. `--name` and `--title` set the app's name and title; by default they come from the folder's name. It
writes nothing over a file that is there unless `--force`.

`app publish` takes every file of the folder but dot files, the README included. Once the app has sources and a build,
publish a folder that holds only the built `index.html` and `ghostly-app.json`, as
[ghostly-chess](https://github.com/MiguelMedeiros/ghostly-chess) does with its `scripts/stage.mjs`.

## Submitting an app

The store's [CONTRIBUTING](https://github.com/MiguelMedeiros/ghostly-store/blob/main/CONTRIBUTING.md) has the details.
In short:

1. Start with `ghostly app init <dir>` ([Starting an app](#starting-an-app)), or build the app yourself as one
   self-contained HTML file (scripts, styles and images inline). Chess, in [`apps/mini/chess`](../apps/mini/chess),
   is an example.
2. Keep `ghostly-app.json` beside it (the manifest without `publisher`, `sequence` and `files`) and run
   `ghostly app publish <dir> --key <your publisher key>`. The first run makes the key: keep it outside the app's folder
   (publish refuses a key inside it, and any private key file found there), back it up, never commit it.
   Set `view` to say where it shows: `"chat"` (the default) for an app that runs inside a chat with one contact, such
   as a game; `"full"` for a full-screen app people open from the Apps page. Any other value is refused.
3. Commit `app.ghostlyapp` to your public GitHub repository.
4. Open a pull request on ghostly-store adding `apps/<name>.<first 16 characters of your key>/listing.json`, with the
   `ref`, `sequence` and `digest` that `ghostly app verify` prints. Its `urls` MUST include a jsDelivr URL pinned to
   a full commit (`https://cdn.jsdelivr.net/gh/<owner>/<repo>@<40-character commit>/app.ghostlyapp`), and may add your
   `HEAD` URL after it. Ghostly installs only the listed digest and reads the pinned URL first, so once `HEAD` holds a
   newer version, the pinned copy is where people still get the reviewed one. For a bundle the store hosts, the pinned
   URL names the store repository's commit. The store's check refuses a listing without one.

## Keys (owner only)

The owner makes the two keys once, on his own machine, from a checkout of this repository:

```sh
tools/scripts/store-keys.sh
```

It makes `~/ghostly-keys` (owner-only; `--keys <dir>` for another folder) with `store.key` and
`chess-publisher.key`, refusing to run if either is there. It builds the CLI and Chess, publishes Chess with its
publisher key into a clone of ghostly-store (`--store <dir>`, by default `../ghostly-store`, cloned when missing),
writes its listing, signs the first index with the store key, and runs the store's own check. It prints only the two
public keys, their fingerprints and the next steps: back the folder up offline, push the store, and set
`DEFAULT_STORE_KEY` to the store's public key. It never pushes and never prints a private key.

### Signing again

An index expires 80 days after it is signed: clients refuse one more than 90 days ahead of their clock, and the margin
covers a clock that is late. Past `expires`, apps still install and the Apps page says the store was not updated. In a
clone of ghostly-store, with the keys at hand:

```sh
npm ci && npm run build-index -- --out /tmp/ghostly-store.draft.json
node <ghostly>/packages/cli/dist/ghostly.mjs store sign /tmp/ghostly-store.draft.json --key ~/ghostly-keys/store.key --out .
GHOSTLY=<ghostly> scripts/check.sh
```

### A new version of Chess

Build Chess, put `dist/index.html` beside a copy of `apps/mini/chess/ghostly-app.json` with `sources` set to the URL in
its listing, and publish over the bundle in the store, which raises `sequence`:

```sh
ghostly app publish <that folder> --key ~/ghostly-keys/chess-publisher.key --out <ghostly-store>/apps/chess.<prefix>/app.ghostlyapp
```

Then update `sequence` and `digest` in its `listing.json`, and sign the index again.

The end-to-end tests run a pinned copy of Chess, `e2e/fixtures/chess`: its page, its `ghostly-app.json`, and
`chess.json` saying where they came from. Chess lives in its own repository, so the fixture is never built here: after
a new version is published, refresh it from the signed bundle with
`node tools/scripts/refresh-chess-fixture.mjs --bundle <app.ghostlyapp, or a URL pinned to a commit>`, which checks
Chess's publisher key and the files' hashes. `--check` fetches the bundle `chess.json` names and compares the bytes;
CI does not run it, since it needs the network. `tools/scripts/test/chessFixture.test.ts` checks, offline, that the
files are the ones `chess.json` describes. `e2e/fixtures/chess/1.0.2` is the last Chess built in this repository,
kept for the update test and the store-keys test.
