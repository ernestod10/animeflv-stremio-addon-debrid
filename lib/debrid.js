// lib/debrid.js - Multi-Debrid Support (Real-Debrid, AllDebrid, Premiumize, Debrid-Link)

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

function isHostSupported(url) {
  if (!url || typeof url !== 'string') return false;
  return SUPPORTED_HOST_REGEXES.some(regex => regex.test(url));
}

function normalizeUrl(url) {
  if (!url) return url;
  let clean = url.trim();

  // Normalize Mega URLs
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

const PROVIDERS = {
  rd: {
    id: 'rd',
    name: 'Real-Debrid',
    tag: '[RD+]',
    unrestrict: async (apiKey, link) => {
      const response = await fetch("https://api.real-debrid.com/rest/1.0/unrestrict/link", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${apiKey}`,
          "Content-Type": "application/x-www-form-urlencoded"
        },
        body: new URLSearchParams({ link }).toString()
      });
      if (!response.ok) {
        const err = await response.text();
        throw new Error(`Real-Debrid error (${response.status}): ${err}`);
      }
      const data = await response.json();
      if (!data.download) throw new Error("Real-Debrid returned no download link");
      return { download: data.download, filename: data.filename, filesize: data.filesize };
    }
  },
  ad: {
    id: 'ad',
    name: 'AllDebrid',
    tag: '[AD+]',
    unrestrict: async (apiKey, link) => {
      const url = `https://api.alldebrid.com/v4/link/unlock?agent=AnimES&apikey=${encodeURIComponent(apiKey)}&link=${encodeURIComponent(link)}`;
      const response = await fetch(url);
      if (!response.ok) {
        const err = await response.text();
        throw new Error(`AllDebrid error (${response.status}): ${err}`);
      }
      const data = await response.json();
      if (data.status !== "success" || !data.data?.download) {
        throw new Error(`AllDebrid failed: ${JSON.stringify(data.error || data)}`);
      }
      return {
        download: data.data.download,
        filename: data.data.filename,
        filesize: data.data.filesize
      };
    }
  },
  pm: {
    id: 'pm',
    name: 'Premiumize',
    tag: '[PM+]',
    unrestrict: async (apiKey, link) => {
      const response = await fetch("https://www.premiumize.me/api/transfer/directdl", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ apikey: apiKey, src: link }).toString()
      });
      if (!response.ok) {
        const err = await response.text();
        throw new Error(`Premiumize error (${response.status}): ${err}`);
      }
      const data = await response.json();
      if (data.status !== "success" || !data.location) {
        throw new Error(`Premiumize failed: ${JSON.stringify(data.message || data)}`);
      }
      return {
        download: data.location,
        filename: data.filename,
        filesize: data.filesize
      };
    }
  },
  dl: {
    id: 'dl',
    name: 'Debrid-Link',
    tag: '[DL+]',
    unrestrict: async (apiKey, link) => {
      const response = await fetch("https://debrid-link.com/api/v2/downloader/add", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${apiKey}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ url: link })
      });
      if (!response.ok) {
        const err = await response.text();
        throw new Error(`Debrid-Link error (${response.status}): ${err}`);
      }
      const data = await response.json();
      if (!data.success || !data.value?.downloadUrl) {
        throw new Error(`Debrid-Link failed: ${JSON.stringify(data.error || data)}`);
      }
      return {
        download: data.value.downloadUrl,
        filename: data.value.name,
        filesize: data.value.size
      };
    }
  }
};

// Provider Aliases
PROVIDERS.realdebrid = PROVIDERS.rd;
PROVIDERS.alldebrid = PROVIDERS.ad;
PROVIDERS.premiumize = PROVIDERS.pm;
PROVIDERS.debridlink = PROVIDERS.dl;

async function unrestrictLink(providerId, apiKey, link) {
  const provKey = (providerId || 'rd').toLowerCase();
  const provider = PROVIDERS[provKey] || PROVIDERS.rd;
  if (!apiKey) throw new Error(`${provider.name} API key is missing`);
  if (!link) throw new Error("Link is missing");

  const cleanLink = normalizeUrl(link);
  const cacheKey = `${provider.id}:${apiKey}:${cleanLink}`;

  const cached = unrestrictCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    console.log(`\x1b[32m[${provider.name}] Cache hit for:\x1b[39m ${cleanLink}`);
    return cached.data;
  }

  console.log(`\x1b[33m[${provider.name}] Unrestricting link:\x1b[39m ${cleanLink}`);
  const data = await provider.unrestrict(apiKey, cleanLink);

  unrestrictCache.set(cacheKey, {
    data,
    expiresAt: Date.now() + CACHE_TTL_MS
  });

  return data;
}

function getProviderInfo(providerId) {
  const provKey = (providerId || 'rd').toLowerCase();
  return PROVIDERS[provKey] || PROVIDERS.rd;
}

module.exports = {
  PROVIDERS,
  getProviderInfo,
  isHostSupported,
  normalizeUrl,
  unrestrictLink
};
