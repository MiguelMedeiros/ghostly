---
section: Fixed / Everywhere
---
- A contact's shared app no longer sends your transport choice to the contact again with each file it loads. Every request did, and each one also made every open Ghostly page draw again: in the extension with 5 tabs open, a page of 83 requests cost each idle tab 40 ms instead of 2 ms. The contact also reads at most 10 of those a minute, so a transport you picked just after opening an app could wait up to a minute to apply.
