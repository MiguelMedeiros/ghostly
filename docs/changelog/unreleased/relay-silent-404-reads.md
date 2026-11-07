---
section: Fixed / Everywhere
---
- With one Pkarr relay taking connections but never answering, every read of something not published yet (a contact's answer, a joiner who is not there yet) waited 6 s for it, again and again, and the relay still showed as working. Such a relay now goes after the others after one wait, and counts as failing as it should.
