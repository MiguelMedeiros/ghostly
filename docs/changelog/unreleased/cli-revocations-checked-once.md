---
section: Fixed / CLI
---
- `app revoke` and `store sign` check each revocation's signature once per run: `app revoke` beside a list of 4095 revocations takes about 3.5 s instead of 7, and `store sign` with 4095 revocations about 4 s instead of 10 to 14 (over an index it already signed). Before, they checked the whole list again on each read of it, the list they had just written included.
