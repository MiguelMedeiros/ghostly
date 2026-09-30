---
section: For developers / Calls
---
- On Linux, the app's log says when the other side's sound and video first arrive and first decode, which path the call took, and how much RTP went each way when it ends. `native_call_stats` carries the same counts as `rtp`, and every call pipeline logs its errors.
