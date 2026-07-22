/**
 * Small allowlist HTML sanitizer for inbound status content (attacker
 * supplied — every inbox row originated from a remote server). No parser
 * dependency (runtime budget); works at the tag-token level. Unknown tags
 * are stripped but their text content is kept; allowlisted tags keep only
 * their allowlisted attributes, and `href`/`src` reject non-http(s) schemes.
 *
 * Fail-safe by construction. The scanner walks the input `<` by `<` (see
 * `LT_RE` below), and every `<` it finds is either fully consumed as part
 * of a tag that matches the recognized grammar — name, then a well-formed
 * attribute list, then a terminating `>` — and processed through the
 * allowlist, or it is HTML-escaped (`&lt;`) and scanning resumes one
 * character past it. There is no third path where an unrecognized `<`
 * (whatever the reason it wasn't recognized: wrong shape, no separator
 * before an attribute, no reachable `>`, anything a future grammar gap
 * might miss) is copied through to the output as live, unescaped markup.
 * An earlier version fell back to passing such spans through verbatim,
 * which turned every gap in tag-grammar coverage into a live XSS bypass;
 * this design cannot repeat that failure mode even if the grammar below is
 * still imperfect, because the *default* outcome for anything it doesn't
 * recognize is "escape", not "trust".
 */

const ALLOWED_TAGS = new Set([
  "p",
  "br",
  "a",
  "span",
  "b",
  "strong",
  "i",
  "em",
  "ul",
  "ol",
  "li",
]);
const ALLOWED_ATTRS: Record<string, readonly string[]> = {
  a: ["href", "rel", "class", "target"],
  span: ["class"],
};

// Finds every literal `<` in the input. This is the outer scan's anchor:
// each match is a *candidate* tag start, and — per the fail-safe design
// above — every one of them is resolved to exactly one of "consumed by a
// recognized tag" or "escaped", never left as ambiguous pass-through text.
// A plain global scan over `<` is unconditionally linear (each `exec` call
// only ever searches forward from the previous match), so this cannot be
// the source of any superlinear behavior; see `scanTagBody` below for why
// the work done *per candidate* is also bounded.
const LT_RE = /</g;

// Matched with the sticky (`y`) flag anchored exactly at a `<` already
// found by `LT_RE`: the optional `/` plus the tag name, no attribute
// content. `scanTagBody` below (a hand-rolled, monotonic-cursor tokenizer)
// locates the rest of the tag: its attribute list and terminating `>`. If
// this doesn't match at that exact position (e.g. a bare `<` in prose, or
// `<3`, or `<!--`), the `<` isn't tag-shaped at all and the caller escapes
// it — see `sanitizeStatusHtml`.
//
// This split is deliberate. A previous version matched a whole tag — name,
// attributes, and `>` — in a single regex whose attribute list was a
// *repeated* group `(?:SEP NAME (=VALUE)?)*`, where the separator class
// `[\s/]+` (added so `<img/src=x>` tokenizes like `<img src=x>`, per
// WHATWG HTML5 and a known filter-evasion technique) and the unquoted-value
// class `[^\s>]*` both match `/`. Whenever a tag never reached a
// terminating `>`, the engine backtracked through every possible way to
// split a run of `/` characters between "end of the previous attribute's
// unquoted value" and "start of the next separator" — exponentially many
// splits for a run of length n — before concluding there was no match.
// Matching only the tag name here has no repeated group at all, so there
// is nothing for *this* regex to backtrack over; see `scanTagBody` for how
// the attribute list is tokenized without reintroducing that shape.
const TAG_NAME_RE = /<(\/?)([a-zA-Z][a-zA-Z0-9]*)/y;

// A single attribute token — separator, name, optional value — matched with
// the sticky (`y`) flag so each `exec` call only ever tries to match
// exactly at `lastIndex`; it never searches ahead the way a non-sticky
// regex does. `scanTagBody` calls this in a loop, advancing `lastIndex` to
// the end of each successful match. Because the match is anchored, a
// failed attempt consumes zero characters and simply ends the loop: there
// is no repetition of this pattern *inside itself*, so a single attempt
// cannot backtrack exponentially, and across the loop the cursor only ever
// moves forward over text it has not already scanned.
//
// Both value alternatives exclude `<` (`[^"<]*`, `[^'<]*`, `[^\s<>]*`) —
// this is load-bearing, not cosmetic. Without it, an unterminated quoted or
// unquoted value greedily consumes across a *subsequent* candidate tag's
// `<…` text (there is nothing else stopping it), so a chain of malformed
// tags — e.g. `("<a x=" + "y".repeat(20)).repeat(n)` — makes a single
// failing `scanTagBody` call walk all the way to the end of the string.
// The outer loop then retries at the next `<` and repeats that same
// O(remaining length) walk, for O(n²) total. Excluding `<` from every
// value class means a value attempt can never read past the next `<`, so a
// failing `scanTagBody` call costs at most O(distance to the next `<`) —
// see the complexity note on `sanitizeStatusHtml`'s main loop for how that
// bounds the whole scan to O(n).
const ATTR_TOKEN_RE = /[\s/]+[a-zA-Z-]+(?:=(?:"[^"<]*"|'[^'<]*'|[^\s<>]*))?/y;
// The optional trailing whitespace / self-closing slash immediately before
// `>`, matched sticky at whatever cursor `scanTagBody`'s attribute loop
// stopped at.
const TAG_CLOSE_RE = /\s*\/?>/y;

// Re-tokenizes one tag's already-bounded attribute text (see `scanTagBody`)
// to pull out name/value pairs for allowlist filtering. This has the same
// "single token, no repeated alternation" shape as `ATTR_TOKEN_RE` — each
// `exec` finds one attribute — so looping it is likewise linear, and it
// only ever runs over a span whose end was already proven reachable.
const ATTR_RE = /([a-zA-Z-]+)(?:=("[^"]*"|'[^']*'|[^\s>]*))?/g;

/**
 * Given the index just after a tag's name, greedily consumes attribute
 * tokens and then the closing `>`, mirroring the grammar the old combined
 * regex encoded, but via a monotonic cursor advanced with sticky regexes:
 * each step either matches at the current cursor and moves it forward, or
 * fails and stops, without ever re-scanning already-consumed text or
 * backtracking across more than one token. Returns the index just past the
 * closing `>` and the raw attribute text, or `null` if this position isn't
 * a well-formed tag (no reachable `>`).
 *
 * On failure, the cursor this function reached internally is discarded —
 * the caller (`sanitizeStatusHtml`) does *not* resume scanning from there.
 * It escapes only the single `<` that started this attempt and resumes at
 * the very next character instead. That is safe (nothing between here and
 * the failure point is treated as anything other than ordinary text, since
 * no tag was recognized) and it is what keeps this whole tokenizer linear:
 * because `ATTR_TOKEN_RE`'s value classes exclude `<` (see its comment),
 * this function's internal walk can never read past the *next* `<` in the
 * input, so the span it examines before failing is disjoint from the span
 * the next call (starting at that next `<`) will examine. Every character
 * is walked by at most one `scanTagBody` call across the whole input.
 */
function scanTagBody(
  html: string,
  nameEnd: number,
): { tagEnd: number; rawAttrs: string } | null {
  let cursor = nameEnd;
  for (;;) {
    ATTR_TOKEN_RE.lastIndex = cursor;
    if (!ATTR_TOKEN_RE.exec(html)) break;
    cursor = ATTR_TOKEN_RE.lastIndex;
  }
  const rawAttrs = html.slice(nameEnd, cursor);
  TAG_CLOSE_RE.lastIndex = cursor;
  if (!TAG_CLOSE_RE.exec(html)) return null;
  return { tagEnd: TAG_CLOSE_RE.lastIndex, rawAttrs };
}

function safeUrl(raw: string): string | null {
  const value = raw.trim();
  if (
    /^(https?:)?\/\//i.test(value) ||
    value.startsWith("/") ||
    value.startsWith("#")
  ) {
    return value;
  }
  return null;
}

// Complexity: the loop's cursor (`lastIndex`, and `LT_RE.lastIndex` kept in
// step with it) advances strictly forward every iteration — either to
// `tagEnd` (past a fully-consumed, successfully-parsed tag) or to
// `tagStart + 1` (past exactly one escaped `<`) — so the number of
// iterations is bounded by `html.length`. Per iteration: `LT_RE.exec`'s
// forward scan for the next `<` is amortized O(1) across the whole loop
// (a monotonically-advancing global-regex scan never revisits a character);
// `TAG_NAME_RE`'s sticky match consumes only characters that are
// provably not `<` (tag-name chars), so distinct attempts never overlap;
// and `scanTagBody` either consumes a span it will never be re-entered for
// (success) or fails after walking at most up to the *next* `<` (see its
// doc comment and `ATTR_TOKEN_RE`'s), which is exactly the span `LT_RE`
// would have had to scan next regardless. No character is ever examined by
// more than a constant number of these operations, so the whole function
// is O(n) in `html.length` — this is what closes the O(n²) DoS: a chain of
// malformed tags no longer causes overlapping re-scans (see
// sanitize.test.ts's ReDoS-resistance suite for a regression test with
// concrete timings).
export function sanitizeStatusHtml(html: string): string {
  let out = "";
  let lastIndex = 0;
  LT_RE.lastIndex = 0;
  let ltMatch: RegExpExecArray | null;
  while ((ltMatch = LT_RE.exec(html)) !== null) {
    const tagStart = ltMatch.index;
    TAG_NAME_RE.lastIndex = tagStart;
    const nameMatch = TAG_NAME_RE.exec(html);
    const body = nameMatch ? scanTagBody(html, TAG_NAME_RE.lastIndex) : null;
    if (nameMatch === null || body === null) {
      // Fail-safe: this `<` isn't the start of a tag the grammar above
      // recognizes — either it isn't tag-shaped at all, or `scanTagBody`
      // never reached a terminating `>`. Escape just this one character
      // (never the whole candidate span) and resume immediately past it.
      out += html.slice(lastIndex, tagStart);
      out += "&lt;";
      lastIndex = tagStart + 1;
      LT_RE.lastIndex = lastIndex;
      continue;
    }
    const { tagEnd, rawAttrs } = body;
    out += html.slice(lastIndex, tagStart);
    lastIndex = tagEnd;
    LT_RE.lastIndex = lastIndex;
    const name = (nameMatch[2] ?? "").toLowerCase();
    const isClosing = nameMatch[1] === "/";
    if (name === "script" || name === "style") {
      // Skip to the matching closing tag, dropping all content between.
      const closeRe = new RegExp(`</${name}\\s*>`, "i");
      const rest = html.slice(lastIndex);
      const closeMatch = closeRe.exec(rest);
      if (closeMatch) {
        lastIndex += closeMatch.index + closeMatch[0].length;
      } else {
        // No matching close tag anywhere in the remainder: drop the rest of
        // the input rather than letting its raw text fall through unescaped.
        lastIndex = html.length;
      }
      LT_RE.lastIndex = lastIndex;
      continue;
    }
    if (!ALLOWED_TAGS.has(name)) continue; // strip tag, keep surrounding text
    if (isClosing) {
      out += `</${name}>`;
      continue;
    }
    const allowedAttrs = ALLOWED_ATTRS[name] ?? [];
    let attrsOut = "";
    ATTR_RE.lastIndex = 0;
    let attrMatch: RegExpExecArray | null;
    while ((attrMatch = ATTR_RE.exec(rawAttrs ?? "")) !== null) {
      const attrName = (attrMatch[1] ?? "").toLowerCase();
      if (!allowedAttrs.includes(attrName)) continue;
      let value = (attrMatch[2] ?? "").replace(/^["']|["']$/g, "");
      if (attrName === "href" || attrName === "src") {
        const safe = safeUrl(value);
        if (safe === null) continue;
        value = safe;
      }
      attrsOut += ` ${attrName}="${value.replace(/"/g, "&quot;")}"`;
    }
    const selfClosing =
      html.slice(tagStart, tagEnd).endsWith("/>") && name === "br";
    out += `<${name}${attrsOut}${selfClosing ? " /" : ""}>`;
  }
  out += html.slice(lastIndex);
  return out;
}
