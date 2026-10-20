---
section: Fixed / CLI
---
- `file send --voice` no longer loads a whole sound into memory to draw its waveform: it measures the sound as it decodes it, and stops reading once the sound is longer than a voice note may be (15 minutes). A 60-minute MP3 took over 3 GB in the daemon before being refused; it now takes as little as a short one.
