---
section: Fixed / Wallets
---
- A check on a payment still on its way that finds nothing new no longer saves the payment again and reloads the whole wallet (every payment, the ecash and the history of each network). With many chat payments waiting for the contact, the wallet did this every few seconds for as long as the app was open.
