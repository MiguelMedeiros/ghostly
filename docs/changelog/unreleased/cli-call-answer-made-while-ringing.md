---
section: Fixed / CLI
---
- `ghostly call answer` sends the answer at once. The daemon now prepares the answer while the call rings, so answering no longer waits for the network check that came after it. That check takes tens of milliseconds where the STUN server replies, and 2 s on a network that blocks it. A declined or missed call closes the connection it prepared, and nothing is sent or heard before the answer.
