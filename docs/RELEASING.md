# Releasing

A release is a tag on `main`. Work lands on `dev`; `main` holds only what was released
([CONTRIBUTING.md](../.github/CONTRIBUTING.md#branches)).

| Step | What |
|---|---|
| [1. Version](#1-version) | bump the version on `dev` |
| [2. Merge into main](#2-merge-into-main) | `dev` → `main`, a merge commit |
| [3. Tag](#3-tag) | the `Release` workflow builds a draft |
| [4. Publish](#4-publish) | verify the draft, publish it as Latest |
| [5. Deploy](#5-deploy) | the web app and the website |

## Before the first release: the updater key

The desktop app installs nothing it cannot verify. Its updater bundles are signed with a key that exists in exactly two places: your machine, and the repository secrets.

```bash
npm run tauri signer generate -- -w ~/.ghostly/updater.key
```

Then, once:

- put the **public** key in `apps/desktop/tauri.conf.json` under `plugins.updater.pubkey` (it is built into every app, which is how an app knows an update is ours);
- add the **private** key as the `TAURI_SIGNING_PRIVATE_KEY` repository secret (`gh secret set TAURI_SIGNING_PRIVATE_KEY < ~/.ghostly/updater.key`) and its password as `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`.

Keep the private key. Losing it means no app already out there can ever be updated again: every future release would be signed by a key they do not trust, and everyone would have to download the app by hand. Rotating it has the same cost, so back it up where you keep your other keys.

## 1. Version

On a branch off `dev`:

```bash
node tools/scripts/bump-version.mjs 1.0.0
```

That sets the version in the root `package.json` and every workspace's (the root `workspaces` field, so a new package under `packages/` moves too), the lock files, the extension manifest, the Tauri config, both crates, the website's fallback release (`apps/website/lib/release.ts`) and the tables in `docs/INSTALLATION.md`, moves the entries of `docs/changelog/unreleased/` into the changelog's `## Unreleased` (deleting the files), and turns that heading into `## 1.0.0` under a new, empty `## Unreleased`. `node tools/scripts/changes.mjs --preview 1.0.0` shows the section beforehand.

An entry with `release: <major>.<minor>` in its front matter is held for that release: a bump to an older version leaves it in `docs/changelog/unreleased/`, so a patch never announces what it does not ship. The Apps entries say `release: 1.2`, and a 1.1.x patch cut from `dev` leaves them there ([the folder's README](changelog/unreleased/README.md)). Until 1.2.0, `node tools/scripts/changes.mjs` (CI) refuses an Apps entry without it (a `For developers / Apps` section, or text about the apps flag, WISP 1200 or `apps/1`), and any front matter key other than `section` and `release`.

The native Android app is in no release before 1.3.0 (the owner's decision, 2026-10-10), so an entry about it says `release: 1.3`: a `... / Android` section, or text that names the Android app or an APK. The same check refuses one without it until 1.3.0, and the `Release` workflow builds and attaches no APK for a tag before its `ANDROID_FROM`, which the check follows ([ANDROID.md](ANDROID.md)). A line about the web app on an Android phone is not held.

Auto-translation is in the Desktop app from 1.7.0 (the owner's decision, 2026-10-27), so an entry about it says `release: 1.7` (the folder's README says which). The `Release` workflow builds the Desktop app with `VITE_TRANSLATE=1` for a tag from its `TRANSLATE_FROM` on, which the check follows, and without it for an older one, so a 1.6.x patch cut from `dev` ships no translation. The web image, the extension and the Android app never carry it in the first version: their builds refuse the flag (`apps/web/translateFlag.ts`).

A patch released from a branch that went into `main` only (a hotfix, or `release/1.7.4`) leaves `dev` at the version before it with that patch's entries still in the folder. The bump refuses to go past a `v*` tag the tree is still before (`dev` at 1.7.3, `v1.7.4` out, a bump to 1.8.0): merge `main` into `dev` first, or the new release announces those entries again and the changelog has no section for the patch.

The bump also refuses a version that must not ship a flag that is on (`RELEASE_GUARDS` in `tools/scripts/changes.mjs`). Apps (`APPS_ENABLED` in `packages/browser/src/shared/features.ts`) ship from 1.2.0: while the flag is `true`, a bump to any version before 1.2.0 stops before it changes a file. The other way too: a bump to 1.2.0 or later stops while the flag is still `false` and the Apps entries held for 1.2 would go out. Any refusal (a flag, a broken entry, no `## Unreleased` heading) comes before the first file changes.

The flag is `true` on `dev` from the 1.2 cut: it was flipped on the `epic/apps-1.2` branch, which merges into `dev` with the owner's OK when 1.2 is cut. From that merge `dev` bumps only to 1.2.0 or later, and every 1.1.x patch is cut from `main`, where the flag is still `false`, so a patch keeps Apps hidden. `tools/scripts/test/bumpVersion.test.ts` checks the repository's own flag both ways: 1.2.0 goes, and a version before it stops. The `Release` workflow runs `node tools/scripts/bump-version.mjs --check` on the tag too, so a tag older than 1.2.0 with the flag on is never built into a release.

Then, by hand:

- **CHANGELOG.md**: read the section as a user would. One line of context on top, the biggest news first, fixes apart.
- **What else mentions features**: `README.md`, `docs/*.md`, and the website's copy in `apps/website/content/` (home, roadmap, developers).
- **Protocol changes** go in `docs/PROTOCOL.md` and the WISPs first. Additive only: older clients must keep working.

Open a pull request into `dev` (`chore(release): 1.0.0`) and merge it once CI is green. CI does not run the app's e2e suites; to know early whether `dev` is ready, run the `E2E` workflow by hand from the Actions tab (or check the nightly `E2E (full)` run). Desktop's Linux harness cannot run on a Mac directly ([e2e/README.md](../e2e/README.md#desktop)); `npm run check:desktop-bundle` runs anywhere.

## 2. Merge into main

Open a pull request from `dev` into `main` and merge it with a **merge commit, never a squash**: a squash makes the next `dev` → `main` merge conflict over everything.

## 3. Tag

```bash
git checkout main && git pull
git tag v1.0.0 && git push origin v1.0.0
```

The `Release` workflow (`.github/workflows/release.yml`) runs the `E2E` workflow from the tag first: the web app and the extension, the Desktop app on Linux, and compatibility with v0.4.0. If it fails, nothing is released: no draft, no web image. Then it builds:

- the desktop apps (macOS arm64 and x64, Windows, Linux);
- the extension zip;
- the web image (`ghcr.io/miguelmedeiros/ghostly-web`, tagged with the version; `latest` moves only once the release is published, step 4.7), with a build provenance signed as `release.yml` run from the tag. Any workflow of the repository can push to the package from any branch, so a tag there proves nothing by itself: the image is deployed only once that provenance checks out (step 5). A run dispatched from a branch signs as that branch and its image never checks out; build it again from the tag (`gh workflow run release.yml --ref v1.0.0 -f tag=v1.0.0`);
- a **draft** release with `SHA256SUMS.txt`, its GPG signature and `latest.json`.

`latest.json` is the whole of what the app's updater reads. Writing it needs `TAURI_SIGNING_PRIVATE_KEY` and its password, and the job fails rather than publish a version nobody can update to.

If a build fails, fix it (on `dev`, then merge into `main` again), move the tag (`git tag -f v1.0.0 && git push -f origin v1.0.0`) and delete the failed draft. Never move a tag whose release was published.

## 4. Publish

A release is not finished while it is a draft: GitHub keeps showing the previous version as **Latest**, and no installed app sees the update. Once it checks out, publish it, always.

1. The Release workflow is green and the draft has all its assets (twelve from 1.0; v0.4.0 had sixteen, with the Rust CLI binaries), `latest.json` among them.
2. Download a few and check them: `shasum -a 256 -c SHA256SUMS.txt --ignore-missing` and `gpg --verify SHA256SUMS.txt.asc SHA256SUMS.txt`.
3. **Apps on macOS, by hand** (releases with Apps on, from 1.2). No e2e covers apps on the macOS Desktop app: `e2e/desktop/apps.spec.ts` runs on Linux only, and `e2e/desktop-macos/` has no apps spec. Install the draft's `.dmg` on a Mac, then:
   - install Chess from the default store on the Apps page;
   - open it in a 1:1 chat with a contact on another device: it opens in a window of its own, titled "Chess with" the contact. That is what shows the window was hardened: on macOS, a window that cannot get its content rule list or WebKit configuration never opens. The app shows the reason instead, and `~/Library/Logs/app.ghostly.chat/ghostly.log` has an `app window app-... closed` line with no window before it;
   - play a few moves each way, close the window and open it again: the game is back.

   If one of these fails, do not publish: fix it and move the tag. A `WebKit has no feature <key>` line in that log (this macOS dropped a switch the window turns off; the window opens anyway) does not block the release by itself. Write the key and the macOS version in the release notes or an issue, and check that the required layers of [WISP 1200](wisps/1200-marketplace.md#per-client), Desktop (the CSP header, the navigation lock, the content rule list), still cover what that switch did.
4. Publish it as the latest release, with the changelog section as notes:

   ```bash
   gh release edit v1.0.0 --draft=false --latest --notes-file notes.md
   ```

5. A download URL (`releases/download/v1.0.0/Ghostly_1.0.0_aarch64.dmg`) answers 200, and so does `releases/latest/download/latest.json`. That address is what every installed app asks, and it only moves to this release once the release is the latest one.

6. Publishing the release starts `Publish npm` (`.github/workflows/npm-publish.yml`), which puts the CLI on npm as `@ghostlytools/cli` (the npm organization `ghostlytools`) at the tag's version, with provenance. It refuses a tag that is not `packages/cli/package.json`'s version, skips a version already on npm, and ends by installing it from npm and running `ghostly --version`. To run it again for a tag: `gh workflow run npm-publish.yml --ref main -f tag=v1.0.0` (the publish jobs run only from `main` or a `v*` tag, and the default branch is neither).

   The same workflow publishes the SDK as `@ghostlytools/sdk` (with the mini-app types at `@ghostlytools/sdk/app`), under the same rules. `verify-sdk` runs `npm run test:sdk-example` on the tag with no token and keeps the tarball it checked; `publish-sdk` publishes that very file with `--ignore-scripts`, with no checkout or install. It runs only while the repository variable `SDK_NPM_PUBLISH` is `true`; otherwise it writes "not published" in the run's summary.

   Only the two publish jobs can ask for an OIDC token, and both run in the GitHub environment `npm`, only from `main` or a `v*` tag. The checks that install a package from npm run in jobs without a token, and so does every install and build from the lockfile: `build-cli` runs `npm ci`, builds the CLI and packs it on the tag with no token, and `publish` publishes that very file with `--ignore-scripts`, with no checkout or install, as `publish-sdk` does for the SDK.

7. Publishing it also starts `Web image latest` (`.github/workflows/web-latest.yml`), which points the web image's `latest` (what `infra/docker-compose.yml` pulls by default) at the release's image. It moves only to GitHub's Latest release and never back: a release with a newer one published leaves it where it is, and the run's summary says why. A draft, or a tag built again, never touches it, and it moves only to the digest whose provenance checks out (`tools/scripts/web-image.mjs`, as in step 5). If the release was published before the Release workflow's web image was pushed, run it again: `gh workflow run web-latest.yml -f tag=v1.0.0`.

8. Publishing it also starts `Chrome Web Store` (`.github/workflows/chrome-web-store.yml`), which uploads the release's `ghostly-browser-extension-<version>.zip` to the store item and submits it for review (`tools/scripts/chrome-web-store.mjs`). Store installs get it from Chrome once Google approves it. It does nothing until the store's credentials are set up ([below](#chrome-web-store)). It skips, with a notice in the run's summary, a draft, a pre-release, a version the store already publishes or a newer one, and a release that comes while the store is still reviewing an earlier upload (a new package cannot go in during a review): run it again once that one is out, `gh workflow run chrome-web-store.yml -f tag=v1.0.0`. It refuses a zip whose `manifest.json` is not the tag's version. A refusal from the store fails that run only, never the release.

### npm trusted publishing

The workflow publishes with npm trusted publishing (OIDC) only: there is no npm token, in the repository or anywhere else. What makes that hold, for `@ghostlytools/cli` and `@ghostlytools/sdk` alike:

1. The npm organization `ghostlytools`, with the publishing npm account as an owner. The packages are scoped to it, so they are private unless published with `--access public` (the workflow does, and `publishConfig` in each `package.json` says so too).
2. On npmjs.com, each package → Settings → Trusted Publisher → GitHub Actions: organization or user `MiguelMedeiros`, repository `ghostly`, workflow filename `npm-publish.yml`, environment `npm`.
3. In the same settings, "Require two-factor authentication and disallow tokens": npm refuses a publish with a token, so a leaked one publishes nothing.
4. On GitHub, Settings → Environments → `npm` → Deployment branches and tags: "Selected branches and tags", with the branch `main` and the tag pattern `v*`. npm's Trusted Publisher checks the repository, the workflow file name and the environment, not the ref, and a run uses the copy of `npm-publish.yml` on the ref it runs from: this rule is what keeps a copy on any other branch out of the environment. The workflow checks the ref too, but a branch's copy can drop that check.
5. A tag ruleset on `v*` restricts creating, moving and deleting those tags, with only the Repository admin role allowed to bypass it. A workflow's token cannot push a `v*` tag, so no workflow can start a release or reach the `npm` environment through one. Do not add GitHub Actions to its bypass list.

The SDK's jobs run only while the repository variable `SDK_NPM_PUBLISH` is `true` (Settings → Secrets and variables → Actions → Variables). A release then publishes both packages.

A new package needs one publish by hand from the owner's npm account (`npm publish --access public` with two-factor authentication) before npm lets it trust the workflow; then steps 2 and 3.

The website's download panel asks GitHub for the latest published release (at most once an hour) and uses it once every installer it links to is attached; until then it keeps the version in `apps/website/lib/release.ts`.

### Chrome Web Store

The workflow signs in as a Google Cloud service account that the store's publisher account trusts (the Chrome Web Store API V2; Google turned V1 off on 15 October 2026). Until the two secrets below exist, every run writes "Chrome Web Store upload not set up" and stops there, before it calls GitHub or the store. Once, from the Google account that owns the item `nbedaagicniejlmfcncndfjcejaidbcf` (it needs two-step verification on):

1. In the [Google Cloud console](https://console.cloud.google.com/), pick or create a project and enable the **Chrome Web Store API** for it.
2. IAM & Admin → Service accounts → create one (say `chrome-web-store-upload`). It needs no role in the project. On it, Keys → Add key → JSON: the browser downloads its key file. A project under a Google Workspace organization may refuse keys (the policy `iam.disableServiceAccountKeyCreation`); a project of a personal account does not.
3. In the [Chrome Web Store Developer Dashboard](https://chrome.google.com/webstore/devconsole), Account: add the service account's email (`...@<project>.iam.gserviceaccount.com`; a publisher can have one). Copy the **publisher ID** from the publisher's settings.
4. On GitHub, Settings → Environments → New environment `chrome-web-store`; under Deployment branches and tags: "Selected branches and tags", with the branch `main` and the tag pattern `v*`, as for `npm`. A run uses the copy of `chrome-web-store.yml` on the ref it runs from, and a repository secret reaches every branch's copy: only an environment's rule keeps the key from a branch's workflow.
5. Add both as secrets of that environment, never of the repository, then delete the downloaded key file:

   ```bash
   gh secret set CWS_SERVICE_ACCOUNT_JSON --env chrome-web-store -R MiguelMedeiros/ghostly < ~/Downloads/<key file>.json
   gh secret set CWS_PUBLISHER_ID --env chrome-web-store -R MiguelMedeiros/ghostly   # paste the publisher ID
   ```

6. Try it on the newest published release: `gh workflow run chrome-web-store.yml --ref main -f tag=v1.0.0` (from any other branch the job is skipped). Its summary says what it did: submitted for review, or why not (the store already has that version, or is reviewing an earlier one).

The key can manage every item of the publisher, and nothing else. To revoke it, delete the key on the service account (or remove the service account from the dashboard) and the secret. The store publishes with the visibility the dashboard has: after changing visibility there, publish once by hand before the workflow can.

## 5. Deploy

Only after publishing.

- **app.ghostly.tools** serves `main`. To move it to the release, from the checkout's root, with `gh` logged in: `tag=$(node tools/scripts/web-image.mjs v1.0.0) && export GHOSTLY_WEB_TAG="$tag"`, then `docker compose -f infra/docker-compose.yml --env-file .env pull` and the same with `up -d`. The script checks the image's provenance (built by `release.yml` from the tag `v1.0.0` of this repository) and prints the tag with the digest it checked, so compose pulls that digest and nothing else; with no provenance it prints nothing and fails, and the `&&` stops there. Never deploy `latest` or a bare tag: anything with write access to the repository can push them. Or build from the checkout with `GHOSTLY_BUILD=$(git rev-parse --short HEAD) docker compose -f infra/docker-compose.yml --env-file .env up -d --build` (`--env-file .env` keeps reading the root `.env`, where the server sets `GHOSTLY_WEB_BIND`). Without `GHOSTLY_BUILD` the image cannot say which commit it serves: `/version.json` says `"build": "dev"` for every image, the same as the one before. Tabs already open are offered a reload when the version number goes up; a new build of the same version is offered only to a tab that already asked the server for a file of its build and found it gone (a wallet's or Iroh's WebAssembly, fetched the first time it is needed), and only when the two builds carry different ids, so an image built without `GHOSTLY_BUILD` never offers it.
- **ghostly.tools**: rebuild the `apps/website/` container. Its `/latest.json` answers with the version in `apps/website/lib/release.ts`, which is how the extension learns about the release.

How each client picks it up:

- **Desktop** offers it by itself, downloads it, checks the signature and restarts into it. On Linux that is the AppImage; a `.deb` belongs to the package manager that installed it, so those are sent to the download.
- **app.ghostly.tools** offers a reload as soon as the new image is up: a tab compares what it is running against `/version.json`.
- **The extension** from the Chrome Web Store updates through Chrome once the store has approved the version step 4.8 submitted. An unpacked one reads `ghostly.tools/latest.json`, so the website has to be rebuilt. Chrome never updates an unpacked extension, so people replace the folder with the new zip and press reload on the extension's card.

## The translation runtime

The Desktop app's translation runtime (`native/translation`) is not in the app's bundle: the app downloads it with the first language model, from a release on a tag of its own, and checks it against the size and SHA-256 it pins (`RUNTIMES` in `apps/desktop/src/translate_models.rs`). It has its own version and ships only when that changes. To cut one, bump `version` in `native/translation/package.json` and `RUNTIME_VERSION` in `apps/desktop/src/translate.rs` together (a test holds them equal; on `dev`, by pull request), then push the tag `translation-runtime-v<that version>` from the merged commit. The `Translation runtime` workflow (`.github/workflows/translation-runtime.yml`) builds the archive on each Desktop platform, checks that it translates there, and publishes a prerelease that never becomes Latest (the updater reads the Latest release's `latest.json`), with the four archives, their `.sha256` files and `runtimes.txt`. A pull request then pastes `runtimes.txt`'s lines (`<platform> <size> <sha256>`) into `RUNTIMES`; no app release goes out between the bump and that pin, or its `RUNTIMES` would name the old archives under the new version. A release that carries translation (`TRANSLATE_FROM` in `release.yml`) checks it before any Desktop build: its `guard` job stops when a Desktop platform has no entry, or an entry is not the size and SHA-256 that `translation-runtime-v<RUNTIME_VERSION>` lists in `runtimes.txt` and its `.sha256` files (`tools/scripts/translation-runtimes.mjs --check`). A published runtime is never replaced: an app that pinned it refuses any other file, so a fix is a new version.

The archive is reproducible: `tools/scripts/prepare-translation-runtime.mjs` packs it with `tools/scripts/tar-gz.mjs` (entries in name order, every time set to the checked-out commit's, owner 0:0, gzip with no time), so building a tag again on the same platform, with Node 22 as the workflow uses, gives the SHA-256 its `.sha256` file published. To check a pin, check out the tag (not a later commit: the commit's time is in every header), run `node tools/scripts/prepare-translation-runtime.mjs` (it runs `npm ci` in `native/translation` itself) and compare `native/translation/dist/*.sha256` with that platform's line in `RUNTIMES`. Runtime 0.1.0 was packed with `tar -czf` and cannot be rebuilt to its published bytes. The next runtime build gives other bytes than 0.1.0's, so it changes every pin and ships as a new version by the steps above.

## Hotfixes

A hotfix branches off `main`, bumps the patch version, is merged into `main` and tagged there (steps 3 to 5). Then `main` is merged back into `dev`.

A fix for a security flaw in a released version never goes through a public issue or pull request, not even into `dev`: it is prepared in the private fork of a GitHub security advisory and disclosed after the release ([SECURITY.md](../.github/SECURITY.md)).

## Security patch releases

A security fix ships in a patch release cut like any other (steps 3 to 5): a person pushes its tag, since the tag ruleset on `v*` lets no workflow create one. Nothing releases a fix by itself. See [SECURITY-REVIEW.md](SECURITY-REVIEW.md).
