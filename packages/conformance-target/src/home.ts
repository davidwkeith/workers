/**
 * The test identity's static content: an h-card homepage advertising every
 * endpoint (several suites start from URL discovery, not the endpoint), and
 * the owner's WebID profile document. Grows test posts for webmention.rocks
 * in P2.
 */

import type { ConformanceEnv } from "./config.js";
import { ownerWebId } from "./config.js";

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
    return new Response("Not Found", { status: 404 });
  };
}
