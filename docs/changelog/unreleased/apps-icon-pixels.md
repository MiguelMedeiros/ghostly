---
section: For developers / Apps
---
- An app's `icon.png` is at most 1024 × 1024 pixels. Only its bytes were bounded (256 KiB), so a small file could ask for a very large picture, which the install screen decoded whole before anything was installed. A larger icon is now refused as `bad-icon` when the bundle is read, and `ghostly app publish` refuses to build it.
