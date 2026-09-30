---
section: For developers / Everywhere
---
- The website's development server (`next dev`) allows `eval()` in its script policy, which React's development build needs for its debugging tools; the built site still never allows it.
