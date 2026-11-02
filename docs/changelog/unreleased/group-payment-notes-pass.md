---
section: Fixed / Groups
---
- On a profile with many payments, each payment that changes no longer costs tens of milliseconds while the app works
  out what to tell its groups: with 1,000 group requests among 5,000 payments, that work took 32 ms each time and now
  takes about 2 ms.
