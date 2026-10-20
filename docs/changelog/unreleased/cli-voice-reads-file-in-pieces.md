---
section: Fixed / CLI
---
- `file send --voice` no longer reads the whole file into the daemon's memory before it looks at it: a WAV and an MP3 are read in pieces, only as far as the waveform needs, and a file ffmpeg decodes (M4A, FLAC…) is read only by ffmpeg. Measuring a 15-minute WAV took about 190 MB more memory and now takes about 27 MB, and a WAV larger than 256 MB is no longer refused as too large to decode.
