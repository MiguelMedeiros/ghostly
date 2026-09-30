---
section: Fixed / Chat
---
- A bot can no longer send buttons that a typed answer could not tell apart: two labels that differ only in case or spaces, or a label that is another button's id. `ghostly send --button` exits 2 naming the duplicate, and the engine refuses such buttons from any sender. An app that receives them anyway takes the first match, as before.
