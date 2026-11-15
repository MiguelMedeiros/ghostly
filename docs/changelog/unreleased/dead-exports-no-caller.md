---
section: For developers
---
- Removed exported functions and settings lists that nothing called or read, in the app, the engine, the CLI and the end-to-end helpers (the CLI's whole-file sound decoders among them; `ghostly file send --voice` keeps measuring a voice note as it reads it).
