---
section: For developers / Everywhere
---
- Release builds strip the symbol table and link with full LTO and one codegen unit, so the app's native library is about a third smaller (54 MB to 36 MB on arm64), at about a minute and a half more per clean build.
