---
section: For developers / CI
---
- The merge train never boards or lands a pull request labelled `queue:hold`, even when it also has `queue` or `queue:priority`: it waits in line, keeps its place, and its position comment says it is on hold until the label comes off. A batch whose pull request gets `queue:hold` before it lands stops there, as for one that left the line. Before, three held pull requests landed on `dev` because a helper had also added `queue`.
