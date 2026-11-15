---
section: Fixed / CLI
---
- `ghostly group call <group> --sfu` told an https origin longer than 200 characters only that it was "not an https origin", and told one with capitals or the default port `:443` that it had a path, query or trailing `/`. It now names the 200-character limit, and says the origin is not in its one spelling (lower case, no default port, path, query or trailing `/`) with the origin to use.
