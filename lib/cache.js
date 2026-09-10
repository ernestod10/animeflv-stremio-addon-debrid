// lib/cache.js

const streamCache = new Map();
const slugCache = new Map();
const metaCache = new Map();

const STREAM_TTL = 6 * 60 * 60 * 1000; // 6 hours
const SLUG_TTL = 24 * 60 * 60 * 1000;   // 24 hours
const META_TTL = 24 * 60 * 60 * 1000;   // 24 hours

// Cleanup expired items periodically
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of streamCache.entries()) if (v.expiresAt < now) streamCache.delete(k);
  for (const [k, v] of slugCache.entries()) if (v.expiresAt < now) slugCache.delete(k);
  for (const [k, v] of metaCache.entries()) if (v.expiresAt < now) metaCache.delete(k);
}, 15 * 60 * 1000);

function getStreamCache(key) {
  const item = streamCache.get(key);
  if (item && item.expiresAt > Date.now()) return item.data;
  return null;
}

function setStreamCache(key, data) {
  if (!data || data.length === 0) return;
  streamCache.set(key, { data, expiresAt: Date.now() + STREAM_TTL });
}

function getSlugCache(provider, title) {
  const key = `${provider}:${title.toLowerCase().trim()}`;
  const item = slugCache.get(key);
  if (item && item.expiresAt > Date.now()) return item.data;
  return null;
}

function setSlugCache(provider, title, slug) {
  if (!slug) return;
  const key = `${provider}:${title.toLowerCase().trim()}`;
  slugCache.set(key, { data: slug, expiresAt: Date.now() + SLUG_TTL });
}

function getMetaCache(imdbId) {
  const item = metaCache.get(imdbId);
  if (item && item.expiresAt > Date.now()) return item.data;
  return null;
}

function setMetaCache(imdbId, meta) {
  if (!meta) return;
  metaCache.set(imdbId, { data: meta, expiresAt: Date.now() + META_TTL });
}

/**
 * Enforces a timeout on a promise to avoid slow providers holding back the response.
 * @param {Promise} promise
 * @param {number} ms
 * @param {string} label
 */
function withTimeout(promise, ms, label = "Operation") {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)
    )
  ]);
}

module.exports = {
  getStreamCache,
  setStreamCache,
  getSlugCache,
  setSlugCache,
  getMetaCache,
  setMetaCache,
  withTimeout
};
