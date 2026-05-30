# `@dwk/webmention`

| | |
|---|---|
| **Type** | endpoint |
| **Ships a DO?** | no |
| **Standard** | [Webmention](https://www.w3.org/TR/webmention/) |

Receives and sends Webmentions for the user's domain.

## Functional requirements

### Receiver

- Accept `source` and `target` parameters, **synchronously validating** before
  returning `202 Accepted` that `source` and `target` are valid URLs and that
  `target` is a resource under this receiver's control. Reject invalid/foreign
  targets up front — this is a spec requirement and prevents queue
  exhaustion / spam.
- **Verify the link asynchronously** via a queue (do not block the request on
  fetching and parsing the source for the `target` link).
- Store verified mentions to an **inbox** (D1, or the pod DO when composed with
  `@dwk/solid-pod`).

### Sender

- Discover Webmention endpoints for outbound links.
- Notify targets **on publish**.

### Federation handoff (documented config, not core code)

- Support emitting `h-card` / `h-entry` and pinging
  [Bridgy Fed](https://fed.brid.gy/) as **documented configuration**, not as
  core code paths.

## Bindings (declared `Env` fragment)

- A **queue** for async verification.
- Inbox storage: D1, or the `@dwk/solid-pod` DO namespace when composed.

## Config

- `baseUrl` / domain.
- Verification queue binding name.
- Inbox storage target.
- Optional federation (Bridgy Fed) settings.

## Conformance

- [webmention.rocks](https://webmention.rocks/) for both sender and receiver.
  See [conformance-and-testing.md](../conformance-and-testing.md).
