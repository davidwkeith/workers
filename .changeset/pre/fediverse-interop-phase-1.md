---
"@dwk/activitypub": minor
---

Typed post objects + shaped publish endpoint (fediverse interop phase 1, #274).

- New `objects.ts`: the canonical `PostInput` shape (`note` / `article` /
  `page`, media attachments with alt text, `sensitive`, blurhash, `to`/`cc`
  overrides) and pure builders producing correctly-addressed AS2
  `Note`/`Article`/`Page` objects — the content shapes Pixelfed (media notes)
  and Lemmy (titled `Page`s) render.
- New owner-gated `POST <actor>/publish` endpoint accepting a bare `PostInput`
  body (same `publishToken` gate as the outbox seam); `POST <actor>/outbox`
  stays purely AS2.
- Inbound activities are now stored with nullable `object_type` / `audience`
  classification columns (annotation only — the liberal store-and-ignore
  behavior for unknown shapes is unchanged).
- Follower rows now record the remote instance's `sharedInbox` alongside the
  delivery inbox, enabling future per-instance fan-out batching.
