---
section: Fixed / CLI
---
- A program that stops reading a call's audio socket (a voice agent that pauses to think) now finds at most 1 s of the contact's voice waiting when it reads again, as meant; what comes meanwhile is dropped. The system's socket buffer came on top of that second: 4.6 s behind at 8 and 16 kHz on Linux, 2.1 s at 48 kHz, 1.5 s at 8 kHz on macOS.
