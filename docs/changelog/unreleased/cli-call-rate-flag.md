---
section: For developers / CLI
---
- `call start`, `call answer` and `call auto on` refuse a `--rate` no call takes (`--rate 44100`) as a usage error (exit 2) that names the flag and the five rates, before the profile opens. Before, the API answered it with exit 1, `bad_request`, "rate must be 8000, 12000, 16000, 24000 or 48000", and `call answer` only once a call rang.
