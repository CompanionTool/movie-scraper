'use strict';

const https = require('https');
const http = require('http');

// Updated to Videasy's official player domain
const REFERER = 'https://player.videasy.net/';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

/**
 * Constructs the Videasy Embed URL based on their documentation.
 */
async function getStream(id, season, episode) {
  // Videasy URL Format:
  // Movie: https://player.videasy.net/movie/{id}
  // TV:    https://player.videasy.net/tv/{id}/{season}/{episode}
  
  if (season) {
    return `https://player.videasy.net/tv/${id}/${season}/${episode || 1}?nextEpisode=true&episodeSelector=true&overlay=true`;
  }
  
  return `https://player.videasy.net/movie/${id}?overlay=true`;
}

/**
 * HLS upstream fetcher (kept for the proxy functionality /api?url=...)
 */
function fetchUpstream(url, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 5) return reject(new Error('too many redirects'));
    (url.startsWith('https') ? https : http).get(url, {
      headers: { 'Referer': REFERER, 'User-Agent': UA, 'Accept': '*/*' }
    }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        const loc = res.headers.location;
        return resolve(fetchUpstream(loc.startsWith('http') ? loc : new URL(loc, url).href, redirects + 1));
      }
      resolve(res);
    }).on('error', reject);
  });
}

/**
 * Replaces segment links in M3U8 files to route back through your proxy
 */
function rewriteM3u8(body, url) {
  const base = url.split('?')[0];
  const baseDir = base.substring(0, base.lastIndexOf('/') + 1);
  const origin = new URL(url).origin;
  return body.split('\n').map(line => {
    const t = line.trim();
    if (!t || t.startsWith('#')) return line;
    const abs = t.startsWith('http') ? t : t.startsWith('/') ? origin + t : baseDir + t;
    return '/api?url=' + encodeURIComponent(abs);
  }).join('\n');
}

// ── Vercel serverless handler ─────────────────────────────────────────────────
module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');

  const { searchParams } = new URL(req.url, 'http://localhost');
  const q = Object.fromEntries(searchParams);

  // 1. Proxy Mode (If you are proxying raw streams)
  if (q.url) {
    const url = decodeURIComponent(q.url);
    try {
      const upstream = await fetchUpstream(url);
      const ct = (upstream.headers['content-type'] || '').toLowerCase();
      const isM3u8 = ct.includes('mpegurl') || ct.includes('m3u8') || /\.m3u8?(\?|$)/i.test(url.split('?')[0]);

      if (isM3u8) {
        const chunks = [];
        for await (const chunk of upstream) chunks.push(chunk);
        const body = Buffer.concat(chunks).toString('utf8');
        res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
        return res.end(rewriteM3u8(body, url));
      } else {
        res.setHeader('Content-Type', ct || 'application/octet-stream');
        res.statusCode = upstream.statusCode;
        upstream.pipe(res);
      }
    } catch (err) {
      res.statusCode = 502;
      res.end(err.message);
    }
    return;
  }

  // 2. Stream Lookup: /api?id=TMDB_ID
  if (!q.id) {
    res.statusCode = 400;
    res.setHeader('Content-Type', 'application/json');
    return res.end(JSON.stringify({ error: 'missing id' }));
  }

  res.setHeader('Content-Type', 'application/json');
  try {
    const url = await getStream(q.id, q.s, q.e);
    // Returns the Videasy Embed URL
    res.end(JSON.stringify({ url }));
  } catch (err) {
    res.statusCode = 500;
    res.end(JSON.stringify({ error: err.message }));
  }
};
