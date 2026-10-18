---
section: For developers / CLI
release: 1.5
---
- A bot keeps x401 credentials: `ghostly x401 key new` makes a holder key for the issuer, `ghostly x401 credential add` keeps the SD-JWT VC it issued, and `list` and `remove` manage them. Claim values print only with `--show-secret`, and nothing is shared with contacts. Showing one to a website comes next.
