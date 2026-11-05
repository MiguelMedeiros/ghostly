---
section: Fixed / Everywhere
---
- Sending or forwarding a fragmented video (a live recording, a stream saved to a file) with a small box beside each
  fragment no longer checks every fragment against every other before it goes. With 16,000 fragments that took 3.7 s
  where the same video without those boxes took 0.65 s; it now takes about 1.1 s.
