---
section: For developers / CLI
---
- A headless call no longer gets later and later: when the daemon was busy for a moment (over 100 ms, as a journal write on a busy disk or a Pkarr publish can be), the call's sender restarted its clock, and what a program wrote meanwhile stayed queued for the rest of the call, so a bot or `call pipe` writing at real time was heard 140 ms, then 640 ms, then over a second late. Now the frames that were due go out right after a stall of up to a second, and the delay stays where it was.
