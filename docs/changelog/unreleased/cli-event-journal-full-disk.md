---
section: Fixed / CLI
---
- After the disk filled up, or a crash cut the event journal's last line, the next event the daemon wrote was glued onto the cut line: `events --since` and `listen --since` never replayed it, said no `events.gap` for it or for the events the full disk took, and after a crash its seq could be given twice. A write the disk takes only part of is now cut back, a cut last line is cut off at the next start without giving its seq again, and a replay says `events.gap` for the events that could not be written.
