# Releasing

A release is a tag. The `Release` workflow builds everything from it and leaves a **draft** on GitHub; nothing is public until the draft is published.

## 1. Version

```bash
node scripts/bump-version.mjs 0.3.0
```

That sets the version in every `package.json`, the lock files, the extension manifest, the Tauri config, both crates, the website's download links (`website/lib/release.ts`) and the tables in `docs/INSTALLATION.md`, and turns `## Unreleased` in the changelog into `## 0.3.0`.

Then, by hand:

- **CHANGELOG.md**: read the section as a user would. One line of context on top, the biggest news first, fixes apart.
- **What else mentions features**: `README.md` (Features), `docs/*.md`, and on the site `Features.tsx`, `Clients.tsx`, `FAQ.tsx`, `MockupApp.tsx` (screenshots) and `ProtocolV1.tsx` when the protocol changed. `node extension/test/site-screenshots.mjs` regenerates the screenshots.
- **Protocol changes** go in `docs/PROTOCOL.md` first. Additive only: older clients must keep working.

Check: `npm run typecheck && npm test && npm run test:e2e`, and `npx next build` in `website/`. The `Release` workflow runs the end-to-end tests again from the tag and makes neither the draft nor the web image if they fail; the `E2E` workflow also runs them every night on `main`, so its latest run says whether `main` is ready.

Open a pull request with all of that (`chore(release): 0.3.0`) and merge it.

## 2. Tag

```bash
git checkout main && git pull
git tag v0.3.0 && git push origin v0.3.0
```

The workflow builds the desktop apps (macOS arm64 and x64, Windows, Linux), the CLI binaries, the extension zip and the web image (`ghcr.io/miguelmedeiros/ghostly-web`), and creates the draft with checksums. It takes about twenty minutes. The Giphy key comes from the `VITE_GIPHY_API_KEY` repository secret.

If a build fails, fix it on `main`, move the tag (`git tag -f v0.3.0 && git push -f origin v0.3.0`) and delete the failed draft. Never move a tag whose release was published.

## 3. Publish

Check that the draft has all thirteen assets, give it the changelog section as notes, and publish it. The site's download buttons point at `releases/download/v0.3.0/…`, so they only work from this moment on.

## 4. Deploy

Only after publishing, or the site offers downloads that do not exist yet.

- **app.ghostly.tools** serves `main`, so it usually has the features already. To move it to the release: `docker compose pull && docker compose up -d`, or build from the checkout with `docker compose up -d --build`.
- **ghostly.tools**: rebuild the `website/` container.

People with the **extension** replace the unpacked folder with the new zip and reload it. The **desktop app** has no updater: they download the new installer.
