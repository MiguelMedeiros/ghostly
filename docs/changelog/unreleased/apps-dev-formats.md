---
section: For developers / Apps
release: 1.2
---
- Mini-apps are built to WISP 1200: a signed `.ghostlyapp` bundle of up to 16 MiB with one HTML entry, a manifest that names its permissions (`chat`, `internet`, `name`) and where it shows (`view`: `chat`, the default, or `full`), signed store indexes and revocations, and the `paired-app` frame of `apps/1` in 1:1 chats, live only.
- The formats are forward compatible: Ghostly reads a manifest, a store index or a listing that carries a key it does not know yet, and the signature still covers every byte. `ghostly app publish`, `ghostly store sign` and a store's own check still refuse an unknown key. Every store listing carries a jsDelivr URL pinned to a commit, which Ghostly reads first.
- An app talks to Ghostly only through `window.ghostly`: its own storage per chat (keys of 256 bytes, values of 64 KiB, 5 MiB per app and chat), messages to the same app on the contact's side, its own files, and with `name` the name the profile shares in that chat. The API and limits are the same on the web app and on Desktop.
- The CLI's and the extension's engines offer no `apps/1` and refuse the app calls, as do Desktop on Windows and the Android app.
