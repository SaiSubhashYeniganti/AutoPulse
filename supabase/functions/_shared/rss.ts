// RSS/Atom parser for Edge Functions.
// Custom regex-based parser (no XML library) — small, reliable for the feeds we care about.
// Handles both standard RSS 2.0 and Atom (Google News uses Atom-ish RSS).

export interface ParsedItem {
  title: string;
  link: string;
  description: string | null;
  pubDate: Date;
  imageUrl: string | null;
  // Google News wraps the original publisher in the description; we extract it.
  originalSource: string | null;
}

export interface ParseResult {
  items: ParsedItem[];
  feedTitle: string | null;
}

// HTML entity decode (just the common ones — XML entities are a small set).
function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(parseInt(code, 10)))
    .replace(
      /&#x([0-9a-fA-F]+);/g,
      (_, code) => String.fromCharCode(parseInt(code, 16)),
    );
}

// Strip HTML tags from a string (for descriptions that come HTML-encoded).
function stripHtml(s: string): string {
  return s.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

// Extract the first <img src="..."> from a string (used for description-embedded images).
function extractFirstImage(html: string): string | null {
  const match = html.match(/<img[^>]*\bsrc=["']([^"']+)["']/i);
  return match ? match[1] : null;
}

// CDATA-aware tag extractor: gets the first occurrence of <tagName>...</tagName>
function extractTag(xml: string, tagName: string): string | null {
  const cdataRe = new RegExp(
    `<${tagName}[^>]*>\\s*<!\\[CDATA\\[([\\s\\S]*?)\\]\\]>\\s*</${tagName}>`,
    "i",
  );
  const cdataMatch = xml.match(cdataRe);
  if (cdataMatch) return cdataMatch[1].trim();

  const plainRe = new RegExp(`<${tagName}[^>]*>([\\s\\S]*?)</${tagName}>`, "i");
  const plainMatch = xml.match(plainRe);
  return plainMatch ? plainMatch[1].trim() : null;
}

// Parse a date string (RFC 822 from RSS, ISO 8601 from Atom). Falls back to now() on failure.
function parseDate(s: string | null): Date {
  if (!s) return new Date();
  const d = new Date(s);
  return isNaN(d.getTime()) ? new Date() : d;
}

// Extract Google News original publisher from a description like:
//   "Article body... <font color="#6f6f6f">Source Name</font>"
// or  "<a href="...">Title</a>&nbsp;&nbsp;<font...>Source Name</font>"
function extractGoogleNewsSource(description: string | null): string | null {
  if (!description) return null;
  const match = description.match(/<font[^>]*>([^<]+)<\/font>\s*$/i);
  return match ? decodeEntities(match[1].trim()) : null;
}

export function parseFeed(xml: string): ParseResult {
  // Remove XML declaration & comments to make matching simpler.
  const cleaned = xml.replace(/<\?xml[^?]*\?>/g, "").replace(
    /<!--[\s\S]*?-->/g,
    "",
  );

  const isAtom = /<feed[\s>]/.test(cleaned) && !/<rss[\s>]/.test(cleaned);

  const feedTitle = extractTag(cleaned, "title");

  // Capture each item / entry block
  const itemRegex = isAtom
    ? /<entry[\s>][\s\S]*?<\/entry>/gi
    : /<item[\s>][\s\S]*?<\/item>/gi;
  const blocks = cleaned.match(itemRegex) ?? [];

  const items: ParsedItem[] = [];

  for (const block of blocks) {
    const rawTitle = extractTag(block, "title");
    if (!rawTitle) continue;
    const title = decodeEntities(stripHtml(rawTitle));

    let link: string | null = null;
    if (isAtom) {
      const linkMatch = block.match(/<link[^>]*\bhref=["']([^"']+)["']/i);
      link = linkMatch ? linkMatch[1] : null;
    } else {
      link = extractTag(block, "link");
      if (!link) {
        const guidMatch = block.match(/<guid[^>]*>([\s\S]*?)<\/guid>/i);
        if (guidMatch) link = guidMatch[1].trim();
      }
    }
    if (!link) continue;
    link = decodeEntities(link.trim());

    const rawDescription = extractTag(block, "description") ??
      extractTag(block, "summary") ?? extractTag(block, "content");
    const description = rawDescription
      ? decodeEntities(stripHtml(rawDescription))
      : null;

    const pubDateStr = extractTag(block, "pubDate") ??
      extractTag(block, "published") ?? extractTag(block, "updated");
    const pubDate = parseDate(pubDateStr);

    // Image: try <media:content url="...">, <enclosure url="...">, then first <img> in description.
    let imageUrl: string | null = null;
    const mediaMatch = block.match(
      /<media:(?:content|thumbnail)[^>]*\burl=["']([^"']+)["']/i,
    );
    if (mediaMatch) imageUrl = mediaMatch[1];
    if (!imageUrl) {
      const enclosureMatch = block.match(
        /<enclosure[^>]*\burl=["']([^"']+)["']/i,
      );
      if (enclosureMatch) imageUrl = enclosureMatch[1];
    }
    if (!imageUrl && rawDescription) {
      imageUrl = extractFirstImage(rawDescription);
    }

    const originalSource = extractGoogleNewsSource(rawDescription);

    items.push({
      title,
      link,
      description: description?.slice(0, 2000) ?? null,
      pubDate,
      imageUrl,
      originalSource,
    });
  }

  return {
    items,
    feedTitle: feedTitle ? decodeEntities(stripHtml(feedTitle)) : null,
  };
}
