---
section: Fixed / CLI
---
- `ghostly app open` works for a served app whose version is longer than 32 characters, such as `1.2.0-beta.3+20261106.a1b2c3d4e5f6a7b8`. A version can have up to 64 characters, but a chat card takes at most 32, so the card was refused and the open was taken back. The card now goes without the version, as the app sends it when a person opens the same app.
