---
"@dwk/webdav": patch
---

Anchor the app-password `pathPrefix` scope on a path-segment boundary (#309).
The check used a raw `startsWith`, so a credential scoped to `/photos` also
authorized the sibling `/photos-private`. It now matches only the prefix
collection itself or a true descendant (`path === base || path.startsWith(base +
"/")`), so a scoped credential can no longer reach adjacent same-prefix
collections. (WAC still applies as the second gate.)
