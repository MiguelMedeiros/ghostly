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
- **It is one store among many.** People can remove it, add other stores by URL, or install an app from its URL or a
  chat card. The default store has no power the others lack.
- **It makes no request by itself.** A profile with no app installed never reads it. It is read when the person opens
  the Apps page, and once an app is installed, at start and every 24 hours.

In the code the store is `DEFAULT_STORE_URL` and `DEFAULT_STORE_KEY` in
[`packages/browser/src/engine/appDefaults.ts`](../packages/browser/src/engine/appDefaults.ts). **While
`DEFAULT_STORE_KEY` is empty the default store is off**: a new profile starts with no store. It stays empty until the
owner makes the key and signs the first index.

## Submitting an app

The store's [CONTRIBUTING](https://github.com/MiguelMedeiros/ghostly-store/blob/main/CONTRIBUTING.md) has the details.
In short:

1. Build the app as one self-contained HTML file (scripts, styles and images inline). Chess, in
   [`apps/mini/chess`](../apps/mini/chess), is an example.
2. Write `ghostly-app.json` beside it (the manifest without `publisher`, `sequence` and `files`) and run
   `ghostly app publish <dir> --key <your publisher key>`. The first run makes the key: back it up, never commit it.
3. Commit `app.ghostlyapp` to your public GitHub repository.
4. Open a pull request on ghostly-store adding `apps/<name>.<first 16 characters of your key>/listing.json`, with the
   `ref`, `sequence` and `digest` that `ghostly app verify` prints.

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
node scripts/build-index.mjs --out /tmp/ghostly-store.draft.json
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
