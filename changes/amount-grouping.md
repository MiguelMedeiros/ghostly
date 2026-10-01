---
section: Fixed / Wallets
---
- Amount fields read thousands the way the app's language writes them: "1.000" is a thousand in Portuguese, Spanish, French and Italian (it was read as 1), and "1,000" in English. A mark that could be either ("1.5" in Portuguese, "1,5" in English, a fraction of a sat) is refused with a short hint, never guessed, and the field shows what was typed.
