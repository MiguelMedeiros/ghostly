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

The bump also refuses a version that must not ship a flag that is on (`RELEASE_GUARDS` in `tools/scripts/changes.mjs`). Apps (`APPS_ENABLED` in `packages/browser/src/shared/features.ts`) ship from 1.2.0: while the flag is `true`, a bump to any version before 1.2.0 stops before it changes a file. The other way too: a bump to 1.2.0 or later stops while the flag is still `false` and the Apps entries held for 1.2 would go out. Any refusal (a flag, a broken entry, no `## Unreleased` heading) comes before the first file changes.

The flag stays `false` on `dev` and flips only on the `release/1.2.0` branch, so every 1.1.x patch keeps Apps hidden. There, flip it and bump to 1.2.0 in the same pull request, the flip first: `tools/scripts/test/bumpVersion.test.ts` checks the flag against the repository's own version, so it is red at 1.1.x with the flag on and green at 1.2.0. The same pull request drops the `expect(APPS_ENABLED).toBe(false)` checks in `packages/browser/test/appsEngine.test.ts` and `packages/browser/test/appsStorage.test.ts`. The `Release` workflow runs `node tools/scripts/bump-version.mjs --check` on the tag too, so a tag older than 1.2.0 with the flag on is never built into a release.

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
- the web image (`ghcr.io/miguelmedeiros/ghostly-web`, tagged with the version and `latest`);
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

6. Publishing the release starts `Publish npm` (`.github/workflows/npm-publish.yml`), which puts the CLI on npm as `@ghostlytools/cli` (the npm organization `ghostlytools`) at the tag's version, with provenance. It refuses a tag that is not `packages/cli/package.json`'s version, skips a version already on npm, and ends by installing it from npm and running `ghostly --version`. To run it again for a tag: `gh workflow run npm-publish.yml -f tag=v1.0.0`.

   The same workflow publishes the SDK as `@ghostlytools/sdk` (with the mini-app types at `@ghostlytools/sdk/app`), under the same rules. `verify-sdk` runs `npm run test:sdk-example` on the tag with no token and keeps the tarball it checked; `publish-sdk` publishes that very file with `--ignore-scripts`, with no checkout or install. It runs only while the repository variable `SDK_NPM_PUBLISH` is `true`; until then it writes "not published" in the run's summary. The SDK is not on npm yet, and `/app` is for Apps, which run from release 1.2: its first publish is the owner's (the steps below, for `@ghostlytools/sdk`, then set the variable).

   Only the two publish jobs can ask for an OIDC token, and both run in the GitHub environment `npm`. The checks that install a package from npm run in jobs without a token.

### npm trusted publishing

The workflow publishes with npm trusted publishing (OIDC), so no npm token is kept. npm only lets a package that exists trust a workflow, so the first time:

1. The npm organization `ghostlytools` exists, with the publishing npm account as an owner. The package is scoped to it, so it is private unless published with `--access public` (the workflow does, and `publishConfig` in `packages/cli/package.json` says so too).
2. Add an npm granular access token with read and write on the `@ghostlytools` scope (allowed to bypass two-factor authentication) as the repository secret `NPM_TOKEN`, and publish the release. The workflow uses it once.
3. On npmjs.com, `@ghostlytools/cli` → Settings → Trusted Publisher → GitHub Actions: organization or user `MiguelMedeiros`, repository `ghostly`, workflow filename `npm-publish.yml`, environment `npm`. A package that trusts the workflow with no environment (`@ghostlytools/cli` until it is edited) lets any job of it publish: set `npm` there too.
4. In the same settings, choose "Require two-factor authentication and disallow tokens", then delete the `NPM_TOKEN` secret and revoke the token.

For `@ghostlytools/sdk` the same four steps apply, with `SDK_NPM_PUBLISH` set to `true` (Settings → Secrets and variables → Actions → Variables) before step 2 and the trusted publisher added on `@ghostlytools/sdk` in step 3. A release then publishes both packages.

The website's download panel asks GitHub for the latest published release (at most once an hour) and uses it once every installer it links to is attached; until then it keeps the version in `apps/website/lib/release.ts`.

## 5. Deploy

Only after publishing.

- **app.ghostly.tools** serves `main`. To move it to the release, from the checkout's root: `docker compose -f infra/docker-compose.yml --env-file .env pull`, then the same with `up -d`, or build from the checkout with `GHOSTLY_BUILD=$(git rev-parse --short HEAD) docker compose -f infra/docker-compose.yml --env-file .env up -d --build` (`--env-file .env` keeps reading the root `.env`, where the server sets `GHOSTLY_WEB_BIND`). Without `GHOSTLY_BUILD` the image cannot say which commit it serves. Tabs already open are offered a reload when the version number goes up, never for a new build of the same version.
- **ghostly.tools**: rebuild the `apps/website/` container. Its `/latest.json` answers with the version in `apps/website/lib/release.ts`, which is how the extension learns about the release.

How each client picks it up:

- **Desktop** offers it by itself, downloads it, checks the signature and restarts into it. On Linux that is the AppImage; a `.deb` belongs to the package manager that installed it, so those are sent to the download.
- **app.ghostly.tools** offers a reload as soon as the new image is up: a tab compares what it is running against `/version.json`.
- **The extension** reads `ghostly.tools/latest.json`, so the website has to be rebuilt. Chrome never updates an unpacked extension, so people replace the folder with the new zip and press reload on the extension's card.

## Hotfixes

A hotfix branches off `main`, bumps the patch version, is merged into `main` and tagged there (steps 3 to 5). Then `main` is merged back into `dev`.

A fix for a security flaw in a released version never goes through a public issue or pull request, not even into `dev`: it is prepared in the private fork of a GitHub security advisory and disclosed after the release ([SECURITY.md](../.github/SECURITY.md)).

## Security patch releases

The security routine pushes its fixes to a `claude/security-auto-*` branch with the patch version already bumped. Once CI passes there, `security-autorelease.yml` (which runs from `main`) checks the branch with `tools/scripts/autorelease-gate.mjs`, fast-forwards `main` to it, tags it, runs the `Release` workflow with `publish: true` and marks the release Latest. The repository variable `SECURITY_AUTORELEASE` chooses what may ship this way: `all` (the default), `deps` or `off`. See [SECURITY-REVIEW.md](SECURITY-REVIEW.md).

After one, merge `main` back into `dev`, and deploy (step 5).
