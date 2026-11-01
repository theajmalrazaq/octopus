// Web access for the brain: search + page reading. Same transport rule as
// the rest of this deployment — undici's fetch with the ProxyAgent when
// WA_USE_PROXY=1 (the global fetch rejects it). Search is Bing first,
// then DuckDuckGo's HTML endpoint, with its instant-answer API as
// fallback; no API key.
import { fetch as undiciFetch, ProxyAgent } from 'undici';

const dispatcher = process.env.WA_USE_PROXY === '1'
  ? new ProxyAgent(process.env.WA_PROXY_URL || 'http://hatch-egress-proxy:3128')
  : undefined;

const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

function stripHtml(s: string): string {
  return s
    .replace(/<[^>]+>/g, ' ')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&#x27;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

export interface SearchHit { title: string; url: string; snippet: string }

// Search order: Bing first (DuckDuckGo's HTML endpoints answer this
// host's egress IP with a 202 bot-challenge page — zero results), then
// DuckDuckGo HTML, then its instant-answer API.
async function bingSearch(q: string): Promise<SearchHit[]> {
  const res = await undiciFetch(`https://www.bing.com/search?q=${encodeURIComponent(q)}&count=8`, {
    headers: { 'User-Agent': UA },
    dispatcher,
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) return [];
  const html = await res.text();
  const blocks = html.split('class="b_algo"').slice(1);
  const hits: SearchHit[] = [];
  for (const block of blocks) {
    if (hits.length >= 5) break;
    const link = /<h2><a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a><\/h2>/.exec(block);
    if (!link) continue;
    let url = link[1].replace(/&amp;/g, '&');
    const uParam = /[?&]u=a1([^&]+)/.exec(url);
    if (uParam) {
      try {
        const b64 = uParam[1].replace(/-/g, '+').replace(/_/g, '/');
        url = Buffer.from(b64, 'base64').toString('utf8');
      } catch { /* keep the redirect URL */ }
    }
    const snip = /<p[^>]*>([\s\S]*?)<\/p>/.exec(block);
    hits.push({ title: stripHtml(link[2]), url, snippet: stripHtml(snip?.[1] || '') });
  }
  return hits;
}

export async function webSearch(query: string): Promise<SearchHit[]> {
  const q = query.trim();
  if (!q) return [];
  try {
    const hits = await bingSearch(q);
    if (hits.length) return hits;
  } catch { /* try the next source */ }
  try {
    const res = await undiciFetch(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(q)}`, {
      headers: { 'User-Agent': UA },
      dispatcher,
      signal: AbortSignal.timeout(15000),
    });
    if (res.ok) {
      const html = await res.text();
      const titles = [...html.matchAll(/<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g)];
      const snippets = [...html.matchAll(/<a[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g)];
      const hits: SearchHit[] = [];
      for (let i = 0; i < Math.min(titles.length, 5); i++) {
        let url = titles[i][1];
        try {
          const u = new URL(url.startsWith('//') ? `https:${url}` : url);
          url = u.searchParams.get('uddg') || url;
        } catch { /* keep raw */ }
        hits.push({ title: stripHtml(titles[i][2]), url, snippet: stripHtml(snippets[i]?.[1] || '') });
      }
      if (hits.length) return hits;
    }
  } catch { /* fall through to the instant-answer API */ }
  const res = await undiciFetch(`https://api.duckduckgo.com/?q=${encodeURIComponent(q)}&format=json&no_html=1&skip_disambig=1`, {
    headers: { 'User-Agent': UA },
    dispatcher,
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`search HTTP ${res.status}`);
  const data = (await res.json()) as {
    AbstractText?: string; AbstractURL?: string; Heading?: string;
    RelatedTopics?: { Text?: string; FirstURL?: string }[];
  };
  const hits: SearchHit[] = [];
  if (data.AbstractText) hits.push({ title: data.Heading || 'Summary', url: data.AbstractURL || '', snippet: data.AbstractText });
  for (const t of data.RelatedTopics || []) {
    if (hits.length >= 5) break;
    if (t.Text && t.FirstURL) hits.push({ title: t.Text.slice(0, 80), url: t.FirstURL, snippet: t.Text });
  }
  return hits;
}

export async function fetchPage(url: string): Promise<{ title: string; text: string }> {
  const u = new URL(url);
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('only http(s) links');
  const res = await undiciFetch(u.toString(), {
    headers: { 'User-Agent': UA },
    dispatcher,
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw new Error(`page HTTP ${res.status}`);
  const raw = await res.text();
  const title = stripHtml(/<title[^>]*>([\s\S]*?)<\/title>/i.exec(raw)?.[1] || '');
  const text = stripHtml(
    raw
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' '),
  );
  return { title, text: text.slice(0, 5000) };
}
