---
section: For developers / Website
---
- Pages on ghostly.tools no longer load the roadmap ahead of time. Its page data is 310 KB, and every page fetched it for the link in the main nav and the footer: over half of the 553 KB a page prefetched. `/roadmap`, `/cli` and `/developers/agents` also fetched up to four WISP pages for their "read more" links (up to 356 KB more). A link to the roadmap or to a WISP's page now loads it when you point at, focus or touch the link, and a click still opens the page at once. The other pages of the nav load ahead as before.
