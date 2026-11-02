---
section: Fixed / Website
---
- The website and the web app tell the proxy in front of them to change nothing in their pages (`Cache-Control: no-transform`), so Cloudflare no longer writes its Web Analytics beacon into every page. The script policy already refused it, but every visit logged a console error and a failed request on sites that have no analytics.
