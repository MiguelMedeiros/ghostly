---
section: Fixed / Everywhere
---
- The released web app and Desktop app no longer obey the test suite's switches in the browser's storage. A leftover
  or pasted `ghostly-test-hold-ttl`, `-pace`, `-iroh`, `-reactions`, `-no-edit` or `-peek-ms` key could shorten how
  long held messages live, lift the web app's request limit toward the public relays, turn Iroh off, make the app
  act like an older one without reactions or edits, or check other profiles every few seconds. They now work only
  in a development build and in the e2e suite's build, like the test wallets and identity providers already did.
  Against a deployed build, the e2e suite now keeps Iroh off the public relays through Settings → Network.
