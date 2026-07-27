/**
 * The test identity's static content: an h-card homepage advertising every
 * endpoint (several suites start from URL discovery, not the endpoint), the
 * owner's WebID profile document, and a webmention.rocks/sender source page
 * (see webmentionQaSourcePage) that gives `sendWebmention` something real to
 * discover a link in.
 */

import type { ConformanceEnv } from "./config.js";
import { ownerWebId } from "./config.js";

/**
 * webmention.rocks/sender numbers its discovery-edge-case targets `test/1`
 * through `test/23`, plus `update/1`, `update/2`, and `delete/1` — 26 in
 * total. It fetches the given `source` synchronously and rejects with `400
 * no_link_found` unless the page literally contains an `<a href>` to the
 * `target` (see conformance/webmention-qa.md's 2026-07-27 note), so every one
 * of them needs a real link on this page.
 */
const WEBMENTION_ROCKS_TARGETS: readonly string[] = [
  ...Array.from({ length: 23 }, (_, i) => `test/${i + 1}`),
  "update/1",
  "update/2",
  "delete/1",
];

type Handler = (
  request: Request,
  env: ConformanceEnv,
  ctx: ExecutionContext,
) => Promise<Response>;

function homePage(base: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>@dwk/workers conformance target</title>
<link rel="indieauth-metadata" href="${base}/.well-known/oauth-authorization-server">
<link rel="authorization_endpoint" href="${base}/authorize">
<link rel="token_endpoint" href="${base}/token">
<link rel="micropub" href="${base}/micropub">
<link rel="microsub" href="${base}/microsub">
<link rel="webmention" href="${base}/webmention">
<link rel="hub" href="${base}/websub">
<link rel="self" href="${base}/">
</head>
<body>
<article class="h-card">
  <a class="u-url p-name" href="${base}/">Conformance Target</a>
  <p class="p-note">Deployed composition of the @dwk/workers packages; the
  target the hosted conformance suites run against.</p>
</article>
</body>
</html>
`;
}

function webmentionQaSourcePage(): string {
  const links = WEBMENTION_ROCKS_TARGETS.map(
    (path) =>
      `  <li><a href="https://webmention.rocks/${path}">${path}</a></li>`,
  ).join("\n");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>webmention.rocks/sender source — @dwk/workers conformance target</title>
</head>
<body>
<article class="h-entry">
  <h1 class="p-name">webmention.rocks/sender source</h1>
  <p class="p-summary">Links this deployment sends against as the
  <code>source</code> when driving <code>POST /webmention/send</code> for the
  webmention.rocks/sender discovery suite (see
  <code>conformance/webmention-qa.md</code>) — one <code>&lt;a href&gt;</code>
  per target so webmention.rocks' synchronous link check finds it.</p>
  <ul>
${links}
  </ul>
</article>
</body>
</html>
`;
}

function profileCard(base: string, webid: string): string {
  return `@prefix foaf: <http://xmlns.com/foaf/0.1/> .
@prefix solid: <http://www.w3.org/ns/solid/terms#> .

<${base}/profile/card>
    a foaf:PersonalProfileDocument ;
    foaf:primaryTopic <${webid}> .

<${webid}>
    a foaf:Person ;
    foaf:name "Conformance Target" .
`;
}

export function createHome(env: ConformanceEnv): Handler {
  const base = env.BASE_URL;
  const webid = ownerWebId(env);
  return async (request) => {
    const path = new URL(request.url).pathname;
    if (path === "/") {
      return new Response(homePage(base), {
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    }
    if (path === "/profile/card") {
      return new Response(profileCard(base, webid), {
        headers: { "content-type": "text/turtle" },
      });
    }
    if (path === "/webmention-qa-source") {
      return new Response(webmentionQaSourcePage(), {
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    }
    return new Response("Not Found", { status: 404 });
  };
}
