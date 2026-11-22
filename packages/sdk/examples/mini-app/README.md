# Example mini-app, typed with `@ghostlytools/sdk/app`

A counter two people share in a chat, written against `@ghostlytools/sdk/app` alone: `window.ghostly`, its storage
and chat, the refusal codes, the limits and the manifest's type. This project is not part of the workspace: it
installs `@ghostlytools/sdk` from a tarball, the way anyone outside the repository would.

```bash
npm run test:sdk-example       # from the repository root: packs the SDK, installs it into a temporary copy of this folder, type checks
```

It type checks with both `bundler` (a Vite project) and `NodeNext` module resolution. To run it in Ghostly, build it
into one HTML file and publish it with `ghostly app publish` ([WISP 1200](../../../../docs/wisps/1200-marketplace.md), Publishing).

## Heavy work

On the web, in Safari (and the iPhone's web app) and in Android Chrome, an app runs on the Ghostly page's own thread:
while your code runs, the person's chats and calls wait for it. Give the thread back often. Split a long computation
(an engine thinking, an image filter) into pieces of a few milliseconds each, with `await new Promise((r) =>
setTimeout(r))` between them. An app that holds the thread for 10 seconds is closed by the client, which tells the
person it stopped responding (WISP 1200, The runner and the broker: the watchdog). Workers for apps are accepted and
come in a later version: until then the runner starts none.
