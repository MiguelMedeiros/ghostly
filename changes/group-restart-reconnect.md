---
section: Fixed / Groups
---
- A group member whose app restarts while the hub's relay budget is spent (by another restart a minute before) is back sooner. The edge used to wait for the hub's 90 s attempt: the member's answer, read late, was never made again, or the hub held on to a first answer that could no longer connect. The member now answers the standing offer again, and the hub dials again as soon as it reads a newer answer.
- A join through a community's link no longer stays "invited" after the joiner's app restarts. The joiner took the door's old packet for a member answering and stopped knocking for up to 10 minutes; it now knocks again, looks fast for the answer, and a lone door answers at once.
