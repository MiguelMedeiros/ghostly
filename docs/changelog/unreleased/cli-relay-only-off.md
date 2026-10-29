---
section: Fixed / CLI
---
- A profile that an older CLI turned Hide my IP from contacts on in can turn it off again: `ghostly engine updateSettings '{"settings":{"relayOnly":false}}'` is no longer refused as "not a setting yet" (turning it on still is, until the release that shows it). While it stayed on, the profile's TURN server could not be removed either.
