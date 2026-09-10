// lib/cache.js
const path = require("path");

const streamCache = new Map();
const slugCache = new Map();
const metaCache = new Map();
const circuitBreaker = new Map(); // provider -> { failures: number, cooldownUntil: number }

const STREAM_TTL = 6 * 60 * 60 * 1000; // 6 hours
const SLUG_TTL = 24 * 60 * 60 * 1000;   // 24 hours
const META_TTL = 24 * 60 * 60 * 1000;   // 24 hours
const MAX_CONSECUTIVE_FAILURES = 3;
const CIRCUIT_COOLDOWN_MS = 5 * 60 * 1000; // 5 minutes

// Optional Persistent Redis (Upstash Redis, Vercel KV, or custom prefix)
let redis = null;
const envUrlKey = Object.keys(process.env).find(k => k.endsWith('_REST_API_URL') || k.endsWith('_REST_URL'));
const envTokenKey = Object.keys(process.env).find(k => k.endsWith('_REST_API_TOKEN') || k.endsWith('_REST_TOKEN'));

const redisUrl = (envUrlKey && process.env[envUrlKey]) || process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
const redisToken = (envTokenKey && process.env[envTokenKey]) || process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;

if (redisUrl && redisToken) {
  try {
    const { Redis } = require("@upstash/redis");
    redis = new Redis({
      url: redisUrl,
      token: redisToken,
    });
    console.log("\x1b[32m[Cache] Persistent Upstash Redis / Vercel KV connected!\x1b[39m");
  } catch (err) {
    console.warn(`[Cache] Warning: could not initialize Redis: ${err.message}`);
  }
} else {
  console.log("[Cache] Running with in-memory + static JSON cache (Set UPSTASH_REDIS_REST_URL to enable cloud persistence)");
}

// Pre-load static slug database into memory
try {
  const staticDb = require(path.join(__dirname, "../data/slug_database.json"));
  const farFuture = Date.now() + 365 * 24 * 60 * 60 * 1000;
  for (const [title, providers] of Object.entries(staticDb)) {
    const normTitle = title.toLowerCase().trim();
    for (const [prov, slug] of Object.entries(providers)) {
      slugCache.set(`${prov}:${normTitle}`, { data: slug, expiresAt: farFuture });
    }
  }
  console.log(`\x1b[32m[Cache] Loaded ${Object.keys(staticDb).length} pre-indexed anime titles into slug cache\x1b[39m`);
} catch (e) {
  console.warn(`[Cache] Notice: static slug database not loaded: ${e.message}`);
}

// Cleanup expired items periodically
const cleanupTimer = setInterval(() => {
  const now = Date.now();
  for (const [k, v] of streamCache.entries()) if (v.expiresAt < now) streamCache.delete(k);
  for (const [k, v] of slugCache.entries()) if (v.expiresAt < now) slugCache.delete(k);
  for (const [k, v] of metaCache.entries()) if (v.expiresAt < now) metaCache.delete(k);
}, 15 * 60 * 1000);
if (cleanupTimer.unref) cleanupTimer.unref();

async function getStreamCache(key) {
  const item = streamCache.get(key);
  if (item && item.expiresAt > Date.now()) return item.data;

  if (redis) {
    try {
      const remote = await redis.get(`stream:${key}`);
      if (remote) {
        const parsed = typeof remote === "string" ? JSON.parse(remote) : remote;
        streamCache.set(key, { data: parsed, expiresAt: Date.now() + STREAM_TTL });
        return parsed;
      }
    } catch (e) {
      console.warn(`[Redis] getStreamCache error: ${e.message}`);
    }
  }
  return null;
}

function setStreamCache(key, data) {
  if (!data || data.length === 0) return;
  streamCache.set(key, { data, expiresAt: Date.now() + STREAM_TTL });

  if (redis) {
    redis.set(`stream:${key}`, JSON.stringify(data), { ex: 12 * 3600 }).catch((e) => {
      console.warn(`[Redis] setStreamCache error: ${e.message}`);
    });
  }
}

async function getSlugCache(provider, title) {
  const key = `${provider.toLowerCase()}:${title.toLowerCase().trim()}`;
  const item = slugCache.get(key);
  if (item && item.expiresAt > Date.now()) return item.data;

  if (redis) {
    try {
      const remote = await redis.get(`slug:${key}`);
      if (remote) {
        slugCache.set(key, { data: remote, expiresAt: Date.now() + SLUG_TTL });
        return remote;
      }
    } catch (e) {
      console.warn(`[Redis] getSlugCache error: ${e.message}`);
    }
  }
  return null;
}

function setSlugCache(provider, title, slug) {
  if (!slug) return;
  const key = `${provider.toLowerCase()}:${title.toLowerCase().trim()}`;
  slugCache.set(key, { data: slug, expiresAt: Date.now() + SLUG_TTL });

  if (redis) {
    redis.set(`slug:${key}`, slug, { ex: 60 * 24 * 3600 }).catch((e) => {
      console.warn(`[Redis] setSlugCache error: ${e.message}`);
    });
  }
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

/* ================= CIRCUIT BREAKER ================= */
function isProviderAvailable(provider) {
  const key = provider.toLowerCase();
  const state = circuitBreaker.get(key);
  if (!state) return true;
  if (state.cooldownUntil && state.cooldownUntil > Date.now()) {
    return false;
  }
  return true;
}

function recordProviderFailure(provider) {
  const key = provider.toLowerCase();
  const state = circuitBreaker.get(key) || { failures: 0, cooldownUntil: 0 };
  state.failures += 1;
  if (state.failures >= MAX_CONSECUTIVE_FAILURES) {
    state.cooldownUntil = Date.now() + CIRCUIT_COOLDOWN_MS;
    console.warn(`\x1b[33m[Circuit Breaker] Provider ${provider} reached ${state.failures} consecutive failures. Temporarily paused for 5m until ${new Date(state.cooldownUntil).toLocaleTimeString()}\x1b[39m`);
  }
  circuitBreaker.set(key, state);
}

function recordProviderSuccess(provider) {
  const key = provider.toLowerCase();
  const state = circuitBreaker.get(key);
  if (state && (state.failures > 0 || state.cooldownUntil > 0)) {
    console.log(`\x1b[32m[Circuit Breaker] Provider ${provider} recovered successfully. Resetting failure count.\x1b[39m`);
    circuitBreaker.set(key, { failures: 0, cooldownUntil: 0 });
  }
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
  isProviderAvailable,
  recordProviderFailure,
  recordProviderSuccess,
  withTimeout
};
