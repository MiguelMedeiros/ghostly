# Releasing

A release is a tag on `main`. Work lands on `dev`; `main` holds only what was released
([CONTRIBUTING.md](../CONTRIBUTING.md#branches)).

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

- put the **public** key in `src-tauri/tauri.conf.json` under `plugins.updater.pubkey` (it is built into every app, which is how an app knows an update is ours);
- add the **private** key as the `TAURI_SIGNING_PRIVATE_KEY` repository secret (`gh secret set TAURI_SIGNING_PRIVATE_KEY < ~/.ghostly/updater.key`) and its password as `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`.

Keep the private key. Losing it means no app already out there can ever be updated again: every future release would be signed by a key they do not trust, and everyone would have to download the app by hand. Rotating it has the same cost, so back it up where you keep your other keys.

## 1. Version

On a branch off `dev`:

```bash
node scripts/bump-version.mjs 1.0.0
```

That sets the version in every `package.json`, the lock files, the extension manifest, the Tauri config, both crates, the website's fallback release (`website/lib/release.ts`) and the tables in `docs/INSTALLATION.md`, moves every entry of `changes/` into the changelog's `## Unreleased` (deleting the files), and turns that heading into `## 1.0.0`. `node scripts/changes.mjs --preview` shows the section beforehand.

Then, by hand:

- **CHANGELOG.md**: read the section as a user would. One line of context on top, the biggest news first, fixes apart.
- **What else mentions features**: `README.md`, `docs/*.md`, and the website's copy in `website/content/` (home, roadmap, developers).
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
3. Publish it as the latest release, with the changelog section as notes:

   ```bash
   gh release edit v1.0.0 --draft=false --latest --notes-file notes.md
   ```

4. A download URL (`releases/download/v1.0.0/Ghostly_1.0.0_aarch64.dmg`) answers 200, and so does `releases/latest/download/latest.json`. That address is what every installed app asks, and it only moves to this release once the release is the latest one.

5. Publishing the release starts `Publish npm` (`.github/workflows/npm-publish.yml`), which puts the CLI on npm as `ghostly-cli` at the tag's version, with provenance. It refuses a tag that is not `packages/cli/package.json`'s version, skips a version already on npm, and ends by installing it from npm and running `ghostly --version`. To run it again for a tag: `gh workflow run npm-publish.yml -f tag=v1.0.0`.

### npm trusted publishing

The workflow publishes with npm trusted publishing (OIDC), so no npm token is kept. npm only lets a package that exists trust a workflow, so the first time:

1. Add an npm automation token as the repository secret `NPM_TOKEN` and publish the release. The workflow uses it once.
2. On npmjs.com, `ghostly-cli` → Settings → Trusted Publisher → GitHub Actions: user `MiguelMedeiros`, repository `ghostly`, workflow `npm-publish.yml`.
3. In the same settings, choose "Require two-factor authentication and disallow tokens", then delete the `NPM_TOKEN` secret and revoke the token.

The website's download panel asks GitHub for the latest published release (at most once an hour) and uses it once every installer it links to is attached; until then it keeps the version in `website/lib/release.ts`.

## 5. Deploy

Only after publishing.

- **app.ghostly.tools** serves `main`. To move it to the release: `docker compose pull && docker compose up -d`, or build from the checkout with `GHOSTLY_BUILD=$(git rev-parse --short HEAD) docker compose up -d --build`. Without `GHOSTLY_BUILD` the image cannot say which commit it serves, and tabs already open are not told about the deploy.
- **ghostly.tools**: rebuild the `website/` container. Its `/latest.json` answers with the version in `website/lib/release.ts`, which is how the extension learns about the release.

How each client picks it up:

- **Desktop** offers it by itself, downloads it, checks the signature and restarts into it. On Linux that is the AppImage; a `.deb` belongs to the package manager that installed it, so those are sent to the download.
- **app.ghostly.tools** offers a reload as soon as the new image is up: a tab compares what it is running against `/version.json`.
- **The extension** reads `ghostly.tools/latest.json`, so the website has to be rebuilt. Chrome never updates an unpacked extension, so people replace the folder with the new zip and press reload on the extension's card.

## Hotfixes

A hotfix branches off `main`, bumps the patch version, is merged into `main` and tagged there (steps 3 to 5). Then `main` is merged back into `dev`.

A fix for a security flaw in a released version never goes through a public issue or pull request, not even into `dev`: it is prepared in the private fork of a GitHub security advisory and disclosed after the release ([SECURITY.md](../SECURITY.md)).

## Security patch releases

The security routine pushes its fixes to a `claude/security-auto-*` branch with the patch version already bumped. Once CI passes there, `security-autorelease.yml` (which runs from `main`) checks the branch with `scripts/autorelease-gate.mjs`, fast-forwards `main` to it, tags it, runs the `Release` workflow with `publish: true` and marks the release Latest. The repository variable `SECURITY_AUTORELEASE` chooses what may ship this way: `all` (the default), `deps` or `off`. See [SECURITY-REVIEW.md](SECURITY-REVIEW.md).

After one, merge `main` back into `dev`, and deploy (step 5).
