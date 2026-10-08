# @ghostlytools/sdk

Build a wallet source (Lightning or on-chain), an identity proof, a mini-app or a minimal client for
[Ghostly](https://github.com/MiguelMedeiros/ghostly) without reading its internals. The adapter
contracts, the fakes and contract test suites the app tests itself with, the plugin registry, the
protocol library, and the mini-app API types (`@ghostlytools/sdk/app`, which imports nothing at run time).
Apps run in Ghostly from release 1.2: an earlier client does not open them.

Read [docs/SDK.md](https://github.com/MiguelMedeiros/ghostly/blob/dev/docs/SDK.md): the rules about
money and secrets, the trust model (an adapter runs with the app's privileges), how a plugin gets into
the app, and how the package is versioned. A complete example lives in `packages/sdk/examples/adapter`, and a
mini-app typed with `@ghostlytools/sdk/app` in `packages/sdk/examples/mini-app`.

Not on npm yet: `npm pack --workspace @ghostlytools/sdk` from a checkout builds and packs it.
