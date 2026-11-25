---
section: Fixed / CLI
---
- `ghostly call pipe` stopped with Ctrl-C says the call goes on and how to end it (`ghostly call hangup <call>`), and exits with 130 like other commands stopped with Ctrl-C. It was killed by the signal with no word, and the contact went on hearing silence.
