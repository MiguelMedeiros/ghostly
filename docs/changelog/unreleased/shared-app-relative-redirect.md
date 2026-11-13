---
section: Fixed / Services
---
- A contact's shared app that redirects to a relative address (`edit`, `?page=2`, `../other`) lands on the page the redirect means. Before, the address was read from the app's root: `edit` from `/admin/users/7` opened `/edit`, and `../other` under a shared base path showed "redirected elsewhere".
