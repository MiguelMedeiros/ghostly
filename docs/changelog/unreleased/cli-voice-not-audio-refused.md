---
section: Fixed / CLI
---
- `file send --voice` refuses an empty file, and a file in which ffmpeg finds no sound, as not a voice note, even with a length (`--voice 2000`): before, the hint "give its length as --voice <ms>" led to a voice note that could not play. The hint is left for a sound that cannot be measured here (no ffmpeg for its kind). The refusal says what is wrong (`notes.txt is text/plain, not audio`, `long.wav is longer than 15 minutes`) instead of one sentence for every case, and ffmpeg's message comes without the memory address it starts with.
