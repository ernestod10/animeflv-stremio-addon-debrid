// lib/realdebrid.js
const RD_API_BASE = "https://api.real-debrid.com/rest/1.0";

// Simple in-memory cache to store unrestrict results: key -> { downloadUrl, expiresAt }
const unrestrictCache = new Map();
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

// Clean cache periodically
setInterval(() => {
  const now = Date.now();
  for (const [key, value] of unrestrictCache.entries()) {
    if (value.expiresAt < now) {
      unrestrictCache.delete(key);
    }
  }
}, 10 * 60 * 1000);

const SUPPORTED_HOST_REGEXES = [
  /1fichier\.com/i,
  /mega\.(nz|co\.nz)/i,
  /streamtape\.(com|to|net|pe)/i,
  /mixdrop\.(co|to|sx|bz|ch|ag)/i,
  /mp4upload\.com/i,
  /mediafire\.com/i,
  /rapidgator\.net/i,
  /ddownload\.com/i,
  /katfile\.com/i,
  /filefactory\.com/i
];

/**
 * Checks if a given URL host is typically supported by Real-Debrid.
 * @param {string} url
 * @returns {boolean}
 */
function isHostSupported(url) {
  if (!url || typeof url !== 'string') return false;
  return SUPPORTED_HOST_REGEXES.some(regex => regex.test(url));
}

/**
 * Normalizes hoster URLs (e.g. Mega embed to direct file URL, 1fichier URLs) so Real-Debrid can parse them properly.
 * @param {string} url
 * @returns {string}
 */
function normalizeUrl(url) {
  if (!url) return url;
  let clean = url.trim();

  // Normalize Mega URLs to standard format: https://mega.nz/file/ID#KEY
  if (clean.includes("mega.nz") || clean.includes("mega.co.nz")) {
    clean = clean.replace(/\/embed\//g, "/file/").replace(/\/embed#!/g, "/file/").replace(/\/#!/g, "/file/");
    const fileIdx = clean.indexOf("/file/");
    if (fileIdx !== -1) {
      let rest = clean.substring(fileIdx + 6);
      if (rest.startsWith("!")) rest = rest.substring(1);
      if (rest.includes("!")) {
        const parts = rest.split("!");
        clean = clean.substring(0, fileIdx + 6) + parts[0] + "#" + parts.slice(1).join("!");
      }
    }
  }

  // Normalize Streamtape embed to watch URL
  if (clean.includes("streamtape.com/e/")) {
    clean = clean.replace("streamtape.com/e/", "streamtape.com/v/");
  }

  // Normalize Mixdrop embed to watch URL
  if (clean.includes("/e/")) {
    const mixdropMatch = clean.match(/mixdrop\.[a-z]+\/e\/([a-zA-Z0-9]+)/);
    if (mixdropMatch) {
      clean = `https://mixdrop.co/f/${mixdropMatch[1]}`;
    }
  }

  return clean;
}

/**
 * Unrestricts a link via Real-Debrid API.
 * @param {string} apiKey Real-Debrid API token
 * @param {string} link Hoster link to unrestrict
 * @returns {Promise<{ download: string, filename: string, filesize: number }>}
 */
async function unrestrictLink(apiKey, link) {
  if (!apiKey) throw new Error("Real-Debrid API key is missing");
  if (!link) throw new Error("Link to unrestrict is missing");

  const cleanLink = normalizeUrl(link);
  const cacheKey = `${apiKey}:${cleanLink}`;

  // Check cache first
  const cached = unrestrictCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    console.log(`\x1b[32m[Real-Debrid] Cache hit for:\x1b[39m ${cleanLink}`);
    return cached.data;
  }

  console.log(`\x1b[33m[Real-Debrid] Unrestricting link:\x1b[39m ${cleanLink}`);

  const formBody = new URLSearchParams({
    link: cleanLink
  });

  const response = await fetch(`${RD_API_BASE}/unrestrict/link`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body: formBody.toString()
  });

  if (!response.ok) {
    const errText = await response.text();
    console.error(`\x1b[31m[Real-Debrid] API error (${response.status}):\x1b[39m ${errText}`);
    throw new Error(`Real-Debrid unrestrict failed: ${response.status} - ${errText}`);
  }

  const data = await response.json();
  if (!data.download) {
    throw new Error(`Real-Debrid did not return a valid download link: ${JSON.stringify(data)}`);
  }

  // Store in cache
  unrestrictCache.set(cacheKey, {
    data: data,
    expiresAt: Date.now() + CACHE_TTL_MS
  });

  return data;
}

/**
 * Checks if the user's Real-Debrid token is valid and active.
 * @param {string} apiKey
 * @returns {Promise<{ valid: boolean, username?: string, premium?: boolean, expiration?: string }>}
 */
async function checkUser(apiKey) {
  if (!apiKey) return { valid: false };
  try {
    const res = await fetch(`${RD_API_BASE}/user`, {
      headers: { "Authorization": `Bearer ${apiKey}` }
    });
    if (!res.ok) return { valid: false };
    const data = await res.json();
    return {
      valid: true,
      username: data.username,
      premium: data.type === 'premium',
      expiration: data.expiration
    };
  } catch (err) {
    console.error("[Real-Debrid] checkUser error:", err);
    return { valid: false };
  }
}

module.exports = {
  isHostSupported,
  normalizeUrl,
  unrestrictLink,
  checkUser
};
