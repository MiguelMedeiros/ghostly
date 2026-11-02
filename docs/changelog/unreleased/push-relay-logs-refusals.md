---
section: Fixed
---
- Push relay (self-hosted): its log says when it turns requests away and why (`refused origin`, `refused method`, `refused rate`, `refused size`), the first at once and the rest as one count a minute. Before, a wrong origin, a request too large or the per-address limit answered 403/405/413/429 with nothing in the log, so an operator could not see why pushes failed. A header sent twice is logged as `refused header twice`, without its name.
