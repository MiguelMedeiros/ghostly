---
section: Fixed
---
- Group calls: in a sealed call, a member whose new epoch secret came late (after the key's retries, about 30 s) kept the old key for good, so the others stopped hearing them without a word. The call now takes the new epoch's key however late its secret reaches the device.
