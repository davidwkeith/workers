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

const TAG_RE =
  /<\/?([a-zA-Z][a-zA-Z0-9]*)((?:\s+[a-zA-Z-]+(?:=(?:"[^"]*"|'[^']*'|[^\s>]*))?)*)\s*\/?>/g;
const ATTR_RE = /([a-zA-Z-]+)(?:=("[^"]*"|'[^']*'|[^\s>]*))?/g;

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
  TAG_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = TAG_RE.exec(html)) !== null) {
    out += html.slice(lastIndex, match.index);
    lastIndex = TAG_RE.lastIndex;
    const [full, rawName, rawAttrs] = match;
    const name = (rawName ?? "").toLowerCase();
    const isClosing = full.startsWith("</");
    if (name === "script" || name === "style") {
      // Skip to the matching closing tag, dropping all content between.
      const closeRe = new RegExp(`</${name}\\s*>`, "i");
      const rest = html.slice(lastIndex);
      const closeMatch = closeRe.exec(rest);
      if (closeMatch) {
        lastIndex += closeMatch.index + closeMatch[0].length;
        TAG_RE.lastIndex = lastIndex;
      }
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
    const selfClosing = full.endsWith("/>") && name === "br";
    out += `<${name}${attrsOut}${selfClosing ? " /" : ""}>`;
  }
  out += html.slice(lastIndex);
  return out;
}
