---
section: For users / CLI
---
- `ghostly group call <group> --sfu <https origin>` lets a community's admin name the node its group calls go through, and `--clear` turns them off. `ghostly group show --json` prints it as `call: {sfu}`, or null. A URL that is not an https origin (http, a path, a trailing slash) is refused before anything is signed, with the origin to use when there is one. Renaming the group or changing its picture keeps its call setting as the admin signed it, sealed call media (`e2ee: 1`) included.
