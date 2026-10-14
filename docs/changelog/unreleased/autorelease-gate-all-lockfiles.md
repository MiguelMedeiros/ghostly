---
section: For developers
---
- The gate that lets a security fix release by itself now reads every lock file the repository ships from. The lock files of the Desktop's HyperDHT sidecar, of the HyperDHT relay for browsers and of Iroh for browsers were read as code: a branch that added a dependency to one of them, or took an existing one from another registry or a git repository, passed the "only versions may change" check, and their lines counted against the 600-line limit. With `SECURITY_AUTORELEASE=deps` a dependency fix in one of them was refused as a code change; it now ships like the others.
