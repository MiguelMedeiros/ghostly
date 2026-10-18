---
section: For developers / Chat
---
- The GIF panel's busy countdown starts in the same commit that shows it (a layout effect), so a test that advances its fake clock right after the wait appears sees the count move. It used to start in an effect React runs a moment later: on a loaded runner the test could advance 10 s before the count existed, read "Try again in 0:30." instead of "0:20.", and click a Try again that was still off.
