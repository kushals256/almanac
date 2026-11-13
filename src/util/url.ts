/** URL helpers (pure): the canonical form used to match sources, and the site name shown to people. */

/** Canonicalise URLs for dedupe: strip tracking params, fragments, www, trailing slash. */
export function canonicalUrl(u: string): string {
  try {
    const url = new URL(u);
    url.hash = "";
    for (const k of [...url.searchParams.keys()]) if (/^(utm_|ref$|fbclid|gclid|mc_)/i.test(k)) url.searchParams.delete(k);
    url.hostname = url.hostname.replace(/^www\./, "");
    let s = url.toString();
    if (s.endsWith("/")) s = s.slice(0, -1);
    return s;
  } catch {
    return u;
  }
}

export function domainOf(u: string): string {
  try {
    return new URL(u).hostname.replace(/^www\./, "");
  } catch {
    return u;
  }
}
