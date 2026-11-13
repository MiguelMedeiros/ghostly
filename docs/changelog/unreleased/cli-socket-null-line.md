---
section: Fixed / CLI
---
- A line on the daemon's socket that is JSON but not an object (`null`, a list, a number) is answered `bad_request` "A request is a JSON object". `null` threw inside the daemon instead, and the requests written in the same go were never answered, so the program waited on them for good.
