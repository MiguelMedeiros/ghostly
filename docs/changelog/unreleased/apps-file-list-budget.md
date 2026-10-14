---
section: Fixed / Apps
---
- An app that keeps links to a large folder of your files (up to 100,000) could ask for their list 50 times a second and keep Ghostly busy copying hundreds of megabytes a second. The list now counts in the same 16 MiB a second as the files an app reads, so a list that large is answered about once a second.
