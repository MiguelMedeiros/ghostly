---
section: Fixed / CLI
---
- `group create` and `group rename` with a name that has nothing that shows (only zero-width characters, say) answer "A group's name needs a character that shows", as a chat's name and the profile's name do, instead of "1 to 64 characters on one line" to a name that was. A name too long, for a chat, the profile or a group, says its count as stored and the character that counts as several ("A chat's name is up to 48 characters as stored (this one is 49: 👨‍👩‍👧‍👦 counts as 7)"), and gives `details.length` and `details.max` (`bad_request`, as before).
