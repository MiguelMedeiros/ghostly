---
section: Fixed / Groups
---
- A group member whose app restarts is back in the group within seconds more often. When the hub read the member's answer too late (its relays' request budget, spent by a restart a minute before), the edge used to wait for the hub's 90 s attempt: 110 s in all. The member now answers the hub's offer again while it stands.
- A join through a community's link no longer stays "invited" after the joiner's app restarts. The joiner took the door's old packet for a member answering and stopped knocking for up to 10 minutes; it now knocks again, looks fast for the answer, and a lone door answers at once.
