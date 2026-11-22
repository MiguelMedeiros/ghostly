---
section: For developers / Tests
---
- `npm run locales:sort -- --check` checks the locale files without writing them: every file's keys in order, no European-Portuguese word in the app's Brazilian Portuguese, Arabic standby said as وضع الاستعداد. CI's lint job runs it, and each problem names the file and the key. The UI tests that checked the same (the Portuguese and Arabic word tests, the i18n order check) are gone.
