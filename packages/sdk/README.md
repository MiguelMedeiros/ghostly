# @ghostly/sdk

Build a wallet source (Lightning or on-chain), an identity proof or a minimal client for
[Ghostly](https://github.com/MiguelMedeiros/ghostly) without reading its internals. The adapter
contracts, the fakes and contract test suites the app tests itself with, the plugin registry, and the
protocol library.

Read [docs/SDK.md](https://github.com/MiguelMedeiros/ghostly/blob/dev/docs/SDK.md): the rules about
money and secrets, the trust model (an adapter runs with the app's privileges), how a plugin gets into
the app, and how the package is versioned. A complete example lives in `examples/sdk-adapter`.

Not on npm yet: `npm pack --workspace @ghostly/sdk` from a checkout builds and packs it.
