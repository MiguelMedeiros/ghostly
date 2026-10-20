---
section: For developers / CLI
---
- `file send --voice` refuses a length out of range (`--voice 0`, `--voice 2.5`, past 15 minutes) and a waveform it does not take (`--peaks 1,2,999`, `--peaks a,b`, more than 128 bars) as a usage error (exit 2) that names the flag, before the profile opens; `--peaks` without `--voice` is refused too. Before, the API answered after the profile opened, with exit 1 and "voice must be a number from 1 to 9007199254740991" or one sentence for every case, and `--peaks` alone was dropped without a word.
