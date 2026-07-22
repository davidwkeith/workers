/**
 * Small allowlist HTML sanitizer for inbound status content (attacker
 * supplied — every inbox row originated from a remote server). No parser
 * dependency (runtime budget); works at the tag-token level. Unknown tags
 * are stripped but their text content is kept; allowlisted tags keep only
 * their allowlisted attributes, and `href`/`src` reject non-http(s) schemes.
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

// Matches only the `<`/`</` plus the tag name — no attribute content.
// `scanTagBody` below (a hand-rolled, monotonic-cursor tokenizer) locates
// the rest of the tag: its attribute list and terminating `>`.
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
const TAG_START_RE = /<(\/?)([a-zA-Z][a-zA-Z0-9]*)/g;

// A single attribute token — separator, name, optional value — matched with
// the sticky (`y`) flag so each `exec` call only ever tries to match
// exactly at `lastIndex`; it never searches ahead the way a non-sticky
// regex does. `scanTagBody` calls this in a loop, advancing `lastIndex` to
// the end of each successful match. Because the match is anchored, a
// failed attempt consumes zero characters and simply ends the loop: there
// is no repetition of this pattern *inside itself*, so a single attempt
// cannot backtrack exponentially, and across the loop the cursor only ever
// moves forward over text it has not already scanned.
const ATTR_TOKEN_RE = /[\s/]+[a-zA-Z-]+(?:=(?:"[^"]*"|'[^']*'|[^\s>]*))?/y;
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
 * a well-formed tag (no reachable `>`) — the same outcome the old regex
 * produced by failing to match, just reached in linear rather than
 * exponential time. The caller treats a `null` result by leaving the
 * leading `<` as ordinary text and continuing to scan for the next
 * possible tag start, exactly as a failed regex match would.
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

export function sanitizeStatusHtml(html: string): string {
  let out = "";
  let lastIndex = 0;
  TAG_START_RE.lastIndex = 0;
  let startMatch: RegExpExecArray | null;
  while ((startMatch = TAG_START_RE.exec(html)) !== null) {
    const tagStart = startMatch.index;
    const nameEnd = TAG_START_RE.lastIndex;
    const body = scanTagBody(html, nameEnd);
    if (body === null) continue; // not a well-formed tag; keep scanning
    const { tagEnd, rawAttrs } = body;
    out += html.slice(lastIndex, tagStart);
    lastIndex = tagEnd;
    TAG_START_RE.lastIndex = lastIndex;
    const name = (startMatch[2] ?? "").toLowerCase();
    const isClosing = startMatch[1] === "/";
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
      TAG_START_RE.lastIndex = lastIndex;
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
