---
section: Fixed / CLI
---
- `ghostly app publish` also refuses an app folder holding a private key base64-encoded (a CI or Kubernetes secret), in a JSON string inside another string, built from one string per line or a JSON array of its lines, indented with tabs, or in a file saved as UTF-16: such a key went out in the public bundle.
