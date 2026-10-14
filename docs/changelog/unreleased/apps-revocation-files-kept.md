---
section: For developers / Apps
---
- Apps: the update check keeps the revocation lists it has already checked, so an unchanged one is not checked again. What it keeps is now limited by size (16 MiB in all) and not only by count (64 files). One app whose publisher serves large lists beside its 8 sources, or a list that changes at every check, could make the page hold hundreds of megabytes until it was closed.
