---
section: For developers / Website
---
- The WISP pages on ghostly.tools load a WISP's page only when you point at, focus or touch its link, not every WISP link on the screen as the page opens: `/wisps` loaded 50 other pages (738 KB, 61% of what it loaded) and a WISP page 36. A click still opens the page at once. The map's tiles, the reader's side list and a WISP's related links use the new `IntentLink`; the main nav keeps Next's default.
