---
section: Fixed / Everywhere
---
- Identities: an OpenPGP key proof signed from a statement file saved as UTF-16 or with a byte order mark (Windows PowerShell's `>`, Notepad's "UTF-8 with BOM") now says so and asks to save it as UTF-8 and sign again, as an SSH key proof does. It said "This signature is not over the Ghostly statement (it signs other text, or it was changed)", or "This signs different text" for `gpg --clearsign`, though the statement was signed unchanged. Both now also recognise a file saved as UTF-16 BE (Notepad's "UTF-16 BE").
