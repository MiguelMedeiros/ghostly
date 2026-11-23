---
section: For developers / Dependencies
---
- The Windows Desktop builds again: the Cargo lockfile had wmi (under iroh's netwatch) on windows 0.62 with windows-core 0.61, so its COM event sink failed to compile on Windows only. wmi takes windows-core 0.62 again, and a test holds every crate that uses both crates to the windows-core its `windows` was built on.
