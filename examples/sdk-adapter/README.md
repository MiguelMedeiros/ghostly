# Example adapters, built with `@ghostly/sdk`

A Lightning source ("Paper Lightning": sats on paper, in memory, regtest) and an identity proof
("Schnorr key": a BIP-340 signature over the statement), written against the SDK alone. This project is
not part of the workspace: it installs `@ghostly/sdk` from a tarball, the way anyone outside the
repository would.

```bash
npm run test:sdk-example       # from the repository root: packs the SDK, installs it here, runs the checks
```

Or by hand: `npm pack --workspace @ghostly/sdk --pack-destination examples/sdk-adapter/vendor`, rename the
tarball to `vendor/ghostly-sdk.tgz`, then `npm install && npm test` here.

To see the adapters in the app, build it with the plugin compiled in:

```bash
GHOSTLY_PLUGINS=examples/sdk-adapter/src/index.ts npm run build:web
```

The Lightning source is then offered when you make a Testnet Lightning wallet (Wallets → New → Testnet →
Lightning; never on Mainnet), and the proof in Identities → New. The e2e build does
this; see `e2e/web/sdk-plugin.spec.ts`. Read [docs/SDK.md](../../docs/SDK.md) before writing your own:
the rules about money and secrets are the point.
