---
section: Fixed / Everywhere
---
- Sending or forwarding a fragmented video with a caption track (a dashcam's or a drone's GPS each second) no longer
  checks each caption run against every fragment's data before it goes. With 32,000 fragments that took 1.7 s where
  the same video without captions took 0.37 s; it now takes about as long as without.
