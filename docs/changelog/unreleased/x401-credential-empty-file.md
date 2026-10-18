---
section: Fixed / CLI
release: 1.5
---
- `ghostly x401 credential add <file>` with an empty file now says "<path> is empty: it holds the SD-JWT VC the issuer sent", and `x401 credential add -` with nothing on stdin "Nothing on stdin: give the SD-JWT VC the issuer sent". Before, both answered "credential is required", the API's parameter name.
