---
section: For developers / Tests
---
- The Linux Desktop's device test (`e2e/desktop/call-devices.spec.ts`) always runs on a PulseAudio of its own. It used the machine's running server when there was one: it switched the person's default microphone and speaker for the run, and on a PipeWire desktop it failed at once (no null source there).
