---
section: Fixed / CLI
release: 1.5
---
- `ghostly x401 credential add` says what became of a key this profile made when a credential bound to it is refused: it already holds another credential (one credential per key), it was dropped for a newer key, or it went with a removed credential. It used to say the profile never made that key. `x401 key new` prints the id of the key it drops past the 8 waiting as `dropped`.
