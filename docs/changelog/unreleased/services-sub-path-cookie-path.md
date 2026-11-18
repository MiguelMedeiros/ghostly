---
section: Fixed / Everywhere
---
- A contact's shared app that you open from a sub-path of their machine (shared as `http://localhost:8888/notes`) now
  keeps its cookies across its pages, so a login there sticks. Before, a cookie the app kept on `/notes` was never sent
  back, because you see the app at `/`.
