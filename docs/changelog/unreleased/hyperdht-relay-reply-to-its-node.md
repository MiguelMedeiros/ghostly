---
section: Fixed / Relays
---
- A HyperDHT relay full to its limits hands each DHT answer to the request it was for. With as many requests out or
  waiting as the DHT has request numbers, about one answer in six after a restart went to another request of the same
  number, sent to another node: that lookup went on with the wrong node's answer while the right request timed out and
  went again, and its queue kept growing at rest. Now the queue empties within two minutes of the restart. If you run your
  own HyperDHT relay, update it from this release.
