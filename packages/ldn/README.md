# `@dwk/ldn`

[Linked Data Notifications](https://www.w3.org/TR/ldn/) (W3C LDN) primitives. A
pure, RDF-only, **protocol-agnostic** library: it implements the three LDN roles
as plain-data functions over [`@dwk/rdf`](../rdf)'s flat `StoredQuad`
representation, with no Cloudflare bindings, no transport, and **no Solid/WAC
assumptions**. The same primitives back the [`@dwk/solid-pod`](../solid-pod)
inbox (discovery) and the [`@dwk/activitypub`](../activitypub) inbox
(advertisement) without either standard leaking into the other.

See the [spec](../../spec/packages/ldn.md) for the authoritative requirements.

## What it does

- **Discovery** — advertise an inbox with `inboxLinkHeader(inboxIri)` (an
  `ldp:inbox` `Link` value) or `inboxTriple(subject, inbox)` (the in-body
  triple), and find one from the consumer side with `parseInboxLinks(header)` or
  `discoverInboxIris(quads, subject?)`.
- **Receiver** — `parseNotification(body, contentType, { baseIRI })` validates a
  posted RDF notification, throwing a `NotificationProblem` that carries the HTTP
  status to answer (`415` for a non-RDF media type, `400` for a body that does
  not parse or has no triples) and otherwise returning the parsed `StoredQuad`s.
- **Consumer** — `inboxListingQuads(inbox, members)` builds the `ldp:Container` +
  `ldp:contains` listing triples; `listInboxMembers(quads, inbox?)` reads them
  back.

Authorization, deduplication, and storage are the **caller's** concern — this
library only speaks RDF and the LDN vocabulary.

## Usage

```ts
import {
  inboxLinkHeader,
  parseNotification,
  NotificationProblem,
} from "@dwk/ldn";

// Producer: advertise the inbox on a target resource's response.
response.headers.set("link", inboxLinkHeader("https://alice.example/inbox/"));

// Receiver: validate an inbound notification before persisting it.
try {
  const { quads } = await parseNotification(
    await request.text(),
    request.headers.get("content-type"),
    { baseIRI: inboxIri },
  );
  // …authorize, dedup, and store `quads`…
} catch (error) {
  if (error instanceof NotificationProblem) {
    return new Response(error.message, { status: error.status });
  }
  throw error;
}
```
