# App screenshots

Playwright specs that drive the built web app with two peers (Boo and Casper) over the
e2e suite's in-process Pkarr relay (`e2e/support/relay.ts`), no network, and save the
marketing screenshots the homepage uses: `components/home/NextSection.tsx`,
`components/home/SpaceSection.tsx` and the finale read them from
`public/screenshots/current/`.

| File | Shots |
| --- | --- |
| `screenshots.spec.ts` | Desktop: invite, chat, file, services, connection, wallet, settings, profile, backups; phone: invite, chat, chat list. |
| `screenshots-mobile.spec.ts` | Phone: file, services, wallet, audio call; desktop: audio call. |
| `screenshots-identities.spec.ts` | Profile → Identities and the chat's Identities dialog, desktop and phone. |
| `helpers.ts` | The peers, the pairing, the conversation, the avatars, `shot()`. |

Shots whose name starts with `x-` are for looking at while composing a section; they are
not used by the site and are not committed.

## Running

From the repository root, with the app built and served in another terminal:

```sh
npm run build:web
npx vite preview web --port 4332 --strictPort
```

```sh
SHOTS=website/public/screenshots/current CAPTURE_URL=http://localhost:4332 \
  npx playwright test -c website/scripts/capture/playwright.config.ts
```

`SHOTS` defaults to `website/public/screenshots/current`; `ONLY=chat,file` saves just the
shots whose names start with those. One spec at a time: append its file name to the
command. Add `--list` to see the tests without running them.

The identities spec signs with the real tools the app tells people to run: it needs
`ssh-keygen` and, for the OpenPGP proof, `gpg` (MacGPG2 or GnuPG) on this machine. The
keys are throwaway ones made in a temporary directory and deleted afterwards.

## PNG → webp

Only `.webp` files are committed. From `website/`, convert every new PNG at quality 82 and
drop the PNG:

```sh
node -e 'const s=require("sharp"),f=require("fs"),d="public/screenshots/current";for(const n of f.readdirSync(d).filter(n=>n.endsWith(".png")))s(`${d}/${n}`).webp({quality:82}).toFile(`${d}/${n.replace(/\.png$/,".webp")}`).then(()=>f.unlinkSync(`${d}/${n}`))'
```

## Notes

- `package.json` here only says `"type": "module"`: Playwright loads a spec as ES module
  or CommonJS by its nearest `package.json`, and `website/` is CommonJS, so without it
  the `import.meta.url` that locates the repository root would not parse.
- The folder is excluded from the website's `tsconfig.json`: Next's ES2017 target rejects
  the BigInt literals in `@ghostly/core`, which the mobile spec imports. After editing the
  specs, type-check them with the e2e suite's settings, from the repository root:

  ```sh
  npx tsc --noEmit --target ES2022 --module ESNext --moduleResolution bundler --strict \
    --skipLibCheck --types node --lib ES2022,DOM,DOM.Iterable website/scripts/capture/*.ts
  ```
