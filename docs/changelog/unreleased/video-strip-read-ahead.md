---
section: Fixed / Everywhere
---
- A fragmented video (a live recording, a stream saved to a file) starts sending sooner: removing its details reads
  its fragments' headers 64 KB at a time instead of two or three small reads per fragment. On the web, with 16,000
  fragments, that step took 10 to 14 s and now takes under 1 s.
