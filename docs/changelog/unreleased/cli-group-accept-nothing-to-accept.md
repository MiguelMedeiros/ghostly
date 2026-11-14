---
section: Fixed / CLI
---
- `ghostly group accept` on a community you are already in, or were removed from or left, is refused with why ("You are in Crew already: there is no invitation to accept", "You were removed from this group: …"). It answered `{"group": …}` with exit 0 as if accepted, though nothing happened. A private group with nothing to accept says the same words instead of a bare "No invitation to accept".
