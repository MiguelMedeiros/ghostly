---
section: Fixed / Website
---
- The app pages on ghostly.tools/apps no longer list a version its publisher revoked before the store copies the revocation. The site now reads the publisher's own `ghostly-revoke.json` beside each of the app's URLs and beside each source its manifest names, checks it as the app does before Install, and leaves the version out, as the app refuses it.
