---
section: For developers / CLI
release: 1.2
---
- `ghostly app publish` never puts a private key in a bundle: a `--key` inside the app's folder is refused before the key is made, and so is a folder holding any private key file (a PEM private key block, or a Ghostly publisher or store key), named in `details.detail`. Before, a key kept in the folder was bundled and published with the app.
