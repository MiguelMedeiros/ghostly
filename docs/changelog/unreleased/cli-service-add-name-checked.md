---
section: Fixed / CLI
---
- `ghostly service add` with a name of only spaces says the name needs a character that shows (`bad_request`), as a chat's or the profile's name does; it answered `engine` ("the engine failed", exit 1). A name over 48 characters is refused naming the limit, where it was cut short with exit 0 and no word.
