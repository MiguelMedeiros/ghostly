---
section: Fixed / Everywhere
---
- Identities: an SSH key proof signed the Windows way, the statement saved to a file and signed with `ssh-keygen -Y sign`, is accepted when the editor ended the file with a Windows line ending, as it already was with a plain newline. It was refused with "The signature is not over this statement".
