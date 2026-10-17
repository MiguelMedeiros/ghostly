---
section: Fixed / CLI
---
- A message whose first word is a dash and one character, such as `send bob -1` or `send bob -5 degrees`, is still refused but now says to put `--` before text that starts with a dash, as longer words like `-ph` already did.
