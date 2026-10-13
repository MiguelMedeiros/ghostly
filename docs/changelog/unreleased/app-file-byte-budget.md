---
section: Fixed / Apps
---
- An app that read a large file of its own bundle many times a second (16 MiB, 50 times a second) made Ghostly copy hundreds of megabytes a second, so the page stalled for most of a second and grew by about a gigabyte. File reads now go one at a time and add up to at most 16 MiB a second per app; past that `ghostly.file` answers `too-fast` until the second has gone.
