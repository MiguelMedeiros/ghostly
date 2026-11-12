---
section: Fixed / CLI
---
- A `ghostly task update` or `routine update` merged into the next update (two within 2.5 s through a daemon) now goes with the newest update's `--text`. Before, the merged card went with the first update's text, so a finished task's message still read "Working: 10%" in an app without cards and in notifications. With no `--text`, the newest update's text is written from the card.
