---
section: Fixed / CLI
---
- `ghostly file send --voice` of an Opus recording (Ogg or WebM) or an MP3 no longer stops the daemon while it measures the note's length and waveform. Before, a 14-minute Opus note held it for 2.2 s, so incoming messages, events, other commands and a call's audio all waited. Now they wait at most a few tens of milliseconds.
