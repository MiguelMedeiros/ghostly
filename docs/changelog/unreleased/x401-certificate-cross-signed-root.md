---
section: For developers / CLI
release: 1.4
---
- A signed x401 request whose certificate chain ends with a cross-signed copy of a trusted root, as many servers send theirs, is no longer refused for leading to no trusted root: the chain stops at the first trusted root, as a browser's does.
