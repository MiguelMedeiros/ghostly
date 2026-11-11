---
section: Fixed / Web
---
- On the web, a contact's shared app page that starts with a UTF-8 byte order mark shows its accents and other scripts right again when the mark arrives in more than one piece. Since 1.11.1 such a page could read as Western European text (`aÃ§Ã£o` for `ação`).
