// Links in a reply that point at the Mac's own localhost. On a phone,
// `localhost` is the phone — the agent's "it's running at http://localhost:5173"
// is a link that can never open — so a tap on one asks the Mac for the site
// instead, and the app shows it.

import type { PreviewTarget } from "./api";

const LOCAL_HOSTS = ["localhost", "127.0.0.1", "[::1]", "0.0.0.0"];

/** Where a link into this Mac's localhost lands, or `null` for any other link. */
export function localLink(href: string | null | undefined): PreviewTarget | null {
  if (!href) return null;
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  if (!LOCAL_HOSTS.includes(url.hostname) && !url.hostname.endsWith(".localhost")) return null;
  const port = url.port ? Number(url.port) : url.protocol === "https:" ? 443 : 80;
  return { port, path: `${url.pathname}${url.search}${url.hash}` };
}
