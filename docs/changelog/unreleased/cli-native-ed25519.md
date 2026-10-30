---
section: Fixed / CLI
---
- `app verify`, `app publish`, `app revoke` and `store sign` check signatures with Node's own Ed25519, about eight times faster: beside a list of 4095 revocations `app verify` and `app publish` take about half a second instead of 3. What verifies is unchanged: Node's check is asked only for keys and signatures the strict check would also read, and any other answer is the strict check's.
