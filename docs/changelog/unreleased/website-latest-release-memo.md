---
section: Fixed / Everywhere
---
- ghostly.tools asks GitHub for the latest release at most once an hour again, also while GitHub is rate-limiting it or not answering: before, each visit to the Apps pages, Privacy or the sitemap asked GitHub again and waited for it (up to 10 seconds), and a few dozen requests kept the site's GitHub allowance drained.
