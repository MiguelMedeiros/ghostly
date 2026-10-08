# Example mini-app, typed with `@ghostlytools/sdk/app`

A counter two people share in a chat, written against `@ghostlytools/sdk/app` alone: `window.ghostly`, its storage
and chat, the refusal codes, the limits and the manifest's type. This project is not part of the workspace: it
installs `@ghostlytools/sdk` from a tarball, the way anyone outside the repository would.

```bash
npm run test:sdk-example       # from the repository root: packs the SDK, installs it into a temporary copy of this folder, type checks
```

It type checks with both `bundler` (a Vite project) and `NodeNext` module resolution. To run it in Ghostly, build it
into one HTML file and publish it with `ghostly app publish` ([WISP 1200](../../../../docs/wisps/1200-marketplace.md), Publishing).
