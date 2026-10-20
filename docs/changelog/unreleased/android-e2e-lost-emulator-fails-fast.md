---
section: For developers
---
- An Android e2e run whose emulator is lost mid-run (about one run in three, during the received video test) fails in minutes with its results uploaded, instead of waiting for a device until the job's 60-minute timeout and ending cancelled with nothing to read. The run's logcat is streamed to the results while the specs run, so it holds the emulator's last lines, and the `adb` calls after the specs and in the Android smoke test have a time limit.
