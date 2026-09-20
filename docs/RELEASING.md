# Releasing

## Before the first release: the updater key

The desktop app installs nothing it cannot verify. Its updater bundles are signed with a key that exists in exactly two places: your machine, and the repository secrets.

```bash
npm run tauri signer generate -- -w ~/.ghostly/updater.key
```

Then, once:

- put the **public** key in `src-tauri/tauri.conf.json` under `plugins.updater.pubkey` (it is built into every app, which is how an app knows an update is ours);
- add the **private** key as the `TAURI_SIGNING_PRIVATE_KEY` repository secret (`gh secret set TAURI_SIGNING_PRIVATE_KEY < ~/.ghostly/updater.key`) and its password as `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`.

Keep the private key. Losing it means no app already out there can ever be updated again: every future release would be signed by a key they do not trust, and everyone would have to download the app by hand. Rotating it has the same cost, so it is worth backing up where you keep your other keys.

A release is a tag. The `Release` workflow builds everything from it and leaves a **draft** on GitHub; nothing is public until the draft is published, and every verified release is published (step 3).

## 1. Version

```bash
node scripts/bump-version.mjs 0.3.0
```

That sets the version in every `package.json`, the lock files, the extension manifest, the Tauri config, both crates, the website's download links (`website/lib/release.ts`) and the tables in `docs/INSTALLATION.md`, and turns `## Unreleased` in the changelog into `## 0.3.0`.

Then, by hand:

- **CHANGELOG.md**: read the section as a user would. One line of context on top, the biggest news first, fixes apart.
- **What else mentions features**: `README.md` (Features), `docs/*.md`, and on the site `Features.tsx`, `Clients.tsx`, `FAQ.tsx`, `MockupApp.tsx` (screenshots) and `ProtocolV1.tsx` when the protocol changed. `node extension/test/site-screenshots.mjs` regenerates the screenshots.
- **Protocol changes** go in `docs/PROTOCOL.md` first. Additive only: older clients must keep working.

Check: `npm run typecheck && npm test && npm run test:e2e`, and `npx next build` in `website/`. The `Release` workflow runs the end-to-end tests again from the tag and makes neither the draft nor the web image if they fail. To know earlier whether `main` is ready, run the `E2E` workflow by hand from the Actions tab.

Open a pull request with all of that (`chore(release): 0.3.0`) and merge it.

## 2. Tag

```bash
git checkout main && git pull
git tag v0.3.0 && git push origin v0.3.0
```

The workflow builds the desktop apps (macOS arm64 and x64, Windows, Linux), the CLI binaries, the extension zip and the web image (`ghcr.io/miguelmedeiros/ghostly-web`), and creates the draft with checksums. It takes about twenty minutes. The Giphy key comes from the `VITE_GIPHY_API_KEY` repository secret.

It also signs one bundle per desktop platform and writes `latest.json`, which is the whole of what the app's updater reads. That step needs `TAURI_SIGNING_PRIVATE_KEY` and its password, and it fails the release rather than publishing a version nobody can update to.

If a build fails, fix it on `main`, move the tag (`git tag -f v0.3.0 && git push -f origin v0.3.0`) and delete the failed draft. Never move a tag whose release was published.

## 3. Publish

A release is not finished while it is a draft: GitHub keeps showing the previous version as **Latest**. Once it checks out, publish it, always.

1. The Release workflow is green and the draft has all eighteen assets, `latest.json` among them.
2. Download a few and check them: `shasum -a 256 -c SHA256SUMS.txt --ignore-missing` and `gpg --verify SHA256SUMS.txt.asc SHA256SUMS.txt`.
3. Publish it as the latest release, with the changelog section as notes:

   ```bash
   gh release edit v0.3.0 --draft=false --latest --notes-file notes.md
   ```

4. A download URL (`releases/download/v0.3.0/Ghostly_0.3.0_aarch64.dmg`) answers 200, and so does `releases/latest/download/latest.json` — that address is what every installed app asks, and it only moves to this release once the release is the latest one.

The site's download buttons point at `releases/download/v0.3.0/…`, so they only work from this moment on.

Security patch releases made by the security routine go through `security-autorelease.yml` instead, which publishes them itself (see [SECURITY-REVIEW.md](SECURITY-REVIEW.md)).

## 4. Deploy

Only after publishing, or the site offers downloads that do not exist yet.

- **app.ghostly.tools** serves `main`, so it usually has the features already. To move it to the release: `docker compose pull && docker compose up -d`, or build from the checkout with `GHOSTLY_BUILD=$(git rev-parse --short HEAD) docker compose up -d --build`. Without `GHOSTLY_BUILD` the image cannot say which commit it serves, and tabs already open are not told about the deploy.
- **ghostly.tools**: rebuild the `website/` container.

How each client picks it up:

- **Desktop** offers it by itself, downloads it, checks the signature and restarts into it. On Linux that is the AppImage; a `.deb` belongs to the package manager that installed it, so those are sent to the download.
- **app.ghostly.tools** offers a reload as soon as the new image is up: a tab compares what it is running against `/version.json`.
- **The extension** learns about it from `ghostly.tools/latest.json`, which is why the website has to be rebuilt. Chrome never updates an unpacked extension, so people still replace the folder with the new zip and press reload on the extension's card.
