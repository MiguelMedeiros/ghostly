---
section: Fixed / CLI
---
- A call placed from the CLI that has not connected 10 s after the contact answered now offers again on a new connection, as the contact's app waits for, instead of staying on "connecting" until the app gives up: a call to the macOS app could end "couldn't connect" when none of the app's connection checks got through on the first try. A contact who hangs up while that offer is on its way is told too, so their app does not ring it as a new call nobody places.
