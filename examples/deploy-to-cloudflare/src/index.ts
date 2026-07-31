/**
 * One-click "Deploy to Cloudflare" starter — `@dwk/webfinger` (RFC 7033) and
 * `@dwk/host-meta` (RFC 6415) composed into a single Worker, the discovery
 * layer of a self-owned web presence.
 *
 * These two packages are chosen deliberately: both are stateless and their
 * `Env` binding fragment is empty, so this Worker needs no D1, R2, KV,
 * Durable Objects, queues, or secrets — it deploys on the free plan with
 * nothing to provision and works the moment it lands on your `*.workers.dev`
 * subdomain. It answers for whatever hostname serves it, so there is nothing
 * to edit before the first deploy succeeds.
 *
 * This directory is intentionally self-contained (its `@dwk` dependencies
 * come from npm, not the workspace) so Cloudflare's deploy button can build
 * it in isolation — and so it mirrors exactly what a third-party consumer of
 * the published packages experiences.
 */

import { createHostMeta, type HostMetaEnv } from "@dwk/host-meta";
import { createWebfinger, type WebfingerEnv } from "@dwk/webfinger";

/** The local part of the `acct:` handle this Worker answers for. */
const USER = "me";

/**
 * Build both discovery handlers for a hostname. Handlers are cheap to
 * construct; building them per request lets the starter answer for whatever
 * hostname it is deployed on. Once you serve one fixed domain, replace the
 * per-request call with a single module-scope `createHandlers("example.com")`.
 */
function createHandlers(host: string) {
  const subject = `acct:${USER}@${host}`;
  const profile = `https://${host}/`;

  const webfinger = createWebfinger({
    resources: {
      [subject]: {
        subject,
        aliases: [profile],
        links: [
          {
            rel: "http://webfinger.net/rel/profile-page",
            type: "text/html",
            href: profile,
          },
        ],
      },
    },
  });

  const hostMeta = createHostMeta({
    webfingerUrl: `https://${host}/.well-known/webfinger`,
  });

  return { webfinger, hostMeta };
}

/**
 * Minimal HTML escape for text interpolated into the landing page. A hostname
 * from `URL.hostname` cannot actually contain HTML metacharacters, but starter
 * code gets copied — never interpolate unescaped input into markup.
 */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** A minimal landing page so the freshly deployed Worker explains itself. */
function landing(rawHost: string): Response {
  const host = escapeHtml(rawHost);
  const webfingerQuery = `/.well-known/webfinger?resource=${encodeURIComponent(
    `acct:${USER}@${rawHost}`,
  )}`;
  const body = `<!doctype html>
<meta charset="utf-8">
<title>@dwk discovery starter</title>
<h1>It works.</h1>
<p>This Worker serves the discovery layer of a self-owned web presence:</p>
<ul>
  <li><a href="${webfingerQuery}">WebFinger (RFC 7033)</a> — <code>acct:${USER}@${host}</code></li>
  <li><a href="/.well-known/host-meta">host-meta (RFC 6415, XRD)</a></li>
  <li><a href="/.well-known/host-meta.json">host-meta.json (JRD)</a></li>
</ul>
<p>Next: compose more <a href="https://github.com/davidwkeith/workers">@dwk packages</a>
into this Worker — IndieAuth, Micropub, Webmention, an edge Solid Pod, ActivityPub.</p>
`;
  return new Response(body, {
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

export default {
  async fetch(request, env, ctx): Promise<Response> {
    const url = new URL(request.url);
    const { webfinger, hostMeta } = createHandlers(url.hostname);

    if (url.pathname === "/.well-known/webfinger") {
      return webfinger(request, env, ctx);
    }
    if (
      url.pathname === "/.well-known/host-meta" ||
      url.pathname === "/.well-known/host-meta.json"
    ) {
      return hostMeta(request, env, ctx);
    }
    if (url.pathname === "/") {
      return landing(url.hostname);
    }
    return new Response("Not found", { status: 404 });
  },
} satisfies ExportedHandler<WebfingerEnv & HostMetaEnv>;
