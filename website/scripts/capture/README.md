# App screenshots

Every app screenshot the website shows comes from here: Playwright specs that drive the built
web app (and, for services, the built extension) with a small cast of people who pair, talk,
send photos, call, pay each other and prove who they are. Peers find each other through the e2e
suite's in-process Pkarr relay (`e2e/support/relay.ts`). Wallets are funded with test coins from
the shared regtest environment (`e2e/infra`), in the app's Testnet mode: no step can touch a
Mainnet wallet, and the Testnet badge and notices the app shows stay in the shots.

## One command

From `website/`:

```sh
npm run capture
```

It joins the shared environment on "one" (`npm run e2e:infra:use -- --host one`: forwards its
ports, writes `.env.e2e`, never starts, resets or seeds it), builds the web app and the extension,
serves the web app with `vite preview` on port 4380, runs the specs with 2 workers, writes each
shot as a 2x WebP into `public/screenshots/current/` under its stable name, and stops the server.
Shots named `x-*` are for looking at while composing a section; they stay in the scratch folder
the command prints and are never committed.

- `npm run capture -- sats.spec.ts` runs one spec; `-- -g phone` the phone tests only.
- `npm run capture -- --no-build` reuses the last builds.
- `ONLY=chat,file` saves just the shots whose names start with those.
- `CAPTURE_PORT` (4380), `CAPTURE_APP_PORT` (4391, the gallery the services spec shares),
  `CAPTURE_WORKERS` (2) and `CAPTURE_INFRA_HOST` (one) move things when they collide.

It needs `ssh-keygen` and `gpg` on this machine (the identity proofs are signed by the real tools,
with throwaway keys in temporary folders) and, for the Spark card, the Spark counterpart's phrase
(`GHOSTLY_SPARK_COUNTERPART`, read from `~/.ghostly-test-identities/spark-regtest-counterpart`
when unset; worthless regtest sats, funded by hand, see e2e/README.md). A rail that cannot be
funded is reported and shot as the app shows it.

## What each spec shoots

| Spec | Shots | Section |
| --- | --- | --- |
| `chat.spec.ts` | `chat`, `file` (desktop and `-mobile`) | Home, "Say it your way" and "Send the actual thing": Boo's chats with four friends, the one with Casper open, then a photo |
| `calls.spec.ts` | `call`, `call-mobile` | "Be a little closer": an audio call (a legacy chat, the only kind that rings) |
| `sats.spec.ts` | `sats`, `sats-mobile` | "A little thank-you": eight wallets funded, 2,100 sats received in the chat, a request paid over Ark, the payment deck open |
| `services.spec.ts` | `services-chat`, `services-mobile` | "Made here. Open there.": a photo gallery on Boo's computer shared with Casper in the extension; the phone shows what sharing needs |
| `groups.spec.ts` | `groups`, `groups-mobile` | "Bring the whole group": a private group with a picture and four members, joined by its link |
| `identities.spec.ts` | `identities-chat`, `identities-chat-mobile` | "Prove who you are": SSH, OpenPGP, Bitcoin (signet) and Nostr proofs, verified on the contact's side |
| `profiles.spec.ts` | `profiles` | "Your space": the Profile page with three profiles and backups |

`helpers.ts` holds the cast (names, colors, pictures drawn on a canvas), pairing, conversations,
`shot()`, persistent profiles and the extension launcher; `wallet.ts` funds each rail;
`gallery.ts` is the little app the services spec shares; `run.mjs` is the command above.

Phone shots use a real phone context (390 × 844, touch, mobile user agent, 2x). Where a phone
needs the same data as the desktop shot (payments, groups, identities), the spec keeps that
person's browser profile on disk and reopens it in a phone context once the desktop one is
closed: the same chats and wallets, on a phone.

Timestamps read like an evening: each context runs in a fixed-offset time zone where it is about
nine at night whenever the capture runs. The clock itself is never faked.

## Notes

- `package.json` here only says `"type": "module"`: Playwright loads a spec as ES module or
  CommonJS by its nearest `package.json`, and `website/` is CommonJS, so without it the
  `import.meta.url` that locates the repository root would not parse.
- The folder is excluded from the website's `tsconfig.json`: Next's ES2017 target rejects the
  BigInt literals in `@ghostly/core`. After editing the specs, type-check them with the e2e
  suite's settings, from the repository root:

  ```sh
  npx tsc --noEmit --target ES2022 --module ESNext --moduleResolution bundler --strict \
    --skipLibCheck --types node --lib ES2022,DOM,DOM.Iterable --allowJs website/scripts/capture/*.ts
  ```
- Voice messages and the pairing progress animation are not shot yet: add a line to the scene
  they belong to once they are on `dev`.
