---
section: Fixed / Chat
---
- With the emoji/GIF panel open, scrolling the emoji grid or the chat behind it, and the screen or the keyboard moving,
  no longer redraws the panel on every frame when it stayed where it was: it is measured once a frame, and only a
  place that changed redraws it. Scrolling its own grid does not measure it at all.
