const express = require("express")
const stream = express.Router()

require('dotenv').config()//process.env.var

const Metadata = require('./metadata_copy.js')
const relationsAPI = require('./relations.js')
const animeFLVAPI = require('./animeFLV.js')
const animeAV1API = require('./animeav1.js')
const henaojaraAPI = require('./henaojara.js')
const tioanimeAPI = require('./tioanime.js')
const animejaraAPI = require('./animejara.js')
const jkanimeAPI = require('./jkanime.js')
const fuzzysort = require('fuzzysort')
const cache = require("../lib/cache.js")

const ALL_PROVIDERS = ['tioanime', 'jkanime', 'animeflv', 'animeav1', 'henaojara', 'animejara'];

/**
 * Executes a stream query with circuit breaker and timeout guards.
 */
function queryProvider(provName, enabledProviders, streamFn) {
  if (!enabledProviders.includes(provName)) {
    return Promise.resolve([])
  }
  if (!cache.isProviderAvailable(provName)) {
    console.log(`\x1b[33m[Circuit Breaker] Skipping ${provName} (in cooldown)\x1b[39m`)
    return Promise.resolve([])
  }
  return cache.withTimeout(Promise.resolve().then(streamFn), 3500, provName)
    .then((streams) => {
      if (Array.isArray(streams) && streams.length > 0) {
        cache.recordProviderSuccess(provName)
        return streams
      }
      return []
    })
    .catch((err) => {
      console.error(`\x1b[31m[${provName}] failed: ${err.message}\x1b[39m`)
      cache.recordProviderFailure(provName)
      return []
    })
}

/**
 * Tipical express middleware callback.
 * @callback subRequestMiddleware
 * @param req - Request sent to our router, containing all relevant info
 * @param res - Our response
 * @param {function} [next] - The next middleware function in the chain, should end the response at some point
 */
function HandleLongStreamRequest(req, res, next) {
  console.log(`\x1b[96mEntered HandleLongStreamRequest with\x1b[39m ${req.originalUrl}`)
  res.locals.extraParams = SearchParamsRegex(req.params[0])
  next()
}

/** 
 * Handles requests to /stream whether they contain extra parameters or just the type and videoID.
 */
async function HandleStreamRequest(req, res, next) {
  console.log(`\x1b[96mEntered HandleStreamRequest with\x1b[39m ${req.originalUrl}`)
  const onlyInternal = (res.locals.config?.get("externalStreams") != 'true')
  const debridProvider = res.locals.config?.get("debridProvider") || "rd"
  const debridKey = res.locals.config?.get("debridKey") || res.locals.config?.get("rdKey") || res.locals.config?.get("realdebrid") || undefined
  const debridOnly = (res.locals.config?.get("debridOnly") === 'true' || res.locals.config?.get("rdOnly") === 'true')
  const baseUrl = `${req.protocol}://${req.get('host')}`

  const streamProvConfig = res.locals.config?.get("streamProviders")
  const enabledProviders = streamProvConfig
    ? streamProvConfig.split(',').map(s => s.trim().toLowerCase())
    : ALL_PROVIDERS

  const streamOptions = {
    onlyInternal,
    debridProvider,
    debridKey,
    debridOnly,
    rdKey: debridKey,
    rdOnly: debridOnly,
    baseUrl
  }

  // 1. Check Stream Cache (RAM + Redis)
  const cacheKey = `${req.params.type}:${req.params.videoId}:${debridProvider}:${debridKey || 'nodebrid'}:${onlyInternal}:${debridOnly}:${enabledProviders.sort().join(',')}`
  const cachedStreams = await cache.getStreamCache(cacheKey)
  if (cachedStreams && cachedStreams.length > 0) {
    console.log(`\x1b[32m[Cache Hit] Returning ${cachedStreams.length} cached streams for ${req.params.videoId}\x1b[39m`)
    res.header('Cache-Control', "max-age=86400, stale-while-revalidate=86400, stale-if-error=259200")
    res.json({ streams: cachedStreams, message: "Got cached streams!" })
    return next()
  }

  let streams = []
  const idDetails = req.params.videoId.split(':')
  const videoID = idDetails[0]

  if ((videoID?.startsWith("animeflv")) || (videoID?.startsWith("animeav1")) || (videoID?.startsWith("henaojara")) || (videoID?.startsWith("tioanime")) || (videoID?.startsWith("animejara")) || (videoID?.startsWith("jkanime"))) {
    const ID = idDetails[1]
    let episode = idDetails[2]
    let season
    if(videoID?.startsWith("animejara")){
      season = idDetails[2]
      episode = idDetails[3]
    }
    console.log(`\x1b[33mGot a ${req.params.type} with ${videoID} ID:\x1b[39m ${ID}`)
    console.log('Extra parameters:', res.locals.extraParams)

    // Direct provider lookup matching the ID
    let providerPromises = []
    if (videoID.startsWith("tioanime")) {
      providerPromises.push(queryProvider("tioanime", ALL_PROVIDERS, () => tioanimeAPI.GetItemStreams(ID, streamOptions, episode)))
    } else if (videoID.startsWith("jkanime")) {
      providerPromises.push(queryProvider("jkanime", ALL_PROVIDERS, () => jkanimeAPI.GetItemStreams(ID, streamOptions, episode)))
    } else if (videoID.startsWith("animeflv")) {
      providerPromises.push(queryProvider("animeflv", ALL_PROVIDERS, () => animeFLVAPI.GetItemStreams(ID, streamOptions, episode)))
    } else if (videoID.startsWith("animeav1")) {
      providerPromises.push(queryProvider("animeav1", ALL_PROVIDERS, () => animeAV1API.GetItemStreams(ID, streamOptions, episode)))
    } else if (videoID.startsWith("henaojara")) {
      providerPromises.push(queryProvider("henaojara", ALL_PROVIDERS, () => henaojaraAPI.GetItemStreams(ID, streamOptions, episode)))
    } else if (videoID.startsWith("animejara")) {
      providerPromises.push(queryProvider("animejara", ALL_PROVIDERS, () => animejaraAPI.GetItemStreams(ID, streamOptions, season, episode)))
    }

    CombineStreams(providerPromises).then((combinedStreams) => {
      if (combinedStreams.length > 0) {
        console.log(`\x1b[36mGot ${combinedStreams.length} streams\x1b[39m`)
        cache.setStreamCache(cacheKey, combinedStreams)
        res.header('Cache-Control', "max-age=86400, stale-while-revalidate=86400, stale-if-error=259200")
        res.json({ streams: combinedStreams, message: "Got streams!" })
        next()
      } else {
        if (!res.headersSent) {
          res.header('Cache-Control', "max-age=86400, stale-while-revalidate=86400, stale-if-error=259200")
          res.json({ streams, message: "Failed getting streams" });
          next()
        }
      }
    })
  } else {
    let episode, season, animeIMDBIDPromise

    if (videoID?.startsWith("tt")) {
      const ID = videoID
      season = idDetails[1]
      episode = idDetails[2]
      console.log(`\x1b[33mGot a ${req.params.type} with IMDB ID:\x1b[39m ${ID}`)
      animeIMDBIDPromise = Promise.resolve(ID)
    } else if (videoID?.startsWith("tmdb")) {
      const ID = idDetails[1]
      season = idDetails[2]
      episode = idDetails[3]
      console.log(`\x1b[33mGot a ${req.params.type} with TMDB ID:\x1b[39m ${ID}`)
      animeIMDBIDPromise = Metadata.GetIMDBIDFromTMDBID(ID, req.params.type)
    } else if (videoID.match(/^(?:kitsu|mal|anidb|anilist)$/)) {
      const ID = idDetails[1]
      episode = idDetails[2]
      console.log(`\x1b[33mGot a ${req.params.type} with ${videoID} ID:\x1b[39m ${ID}`)
      animeIMDBIDPromise = relationsAPI.GetIMDBIDFromANIMEID(videoID, ID)
    } else {
      if (!res.headersSent) {
        res.header('Cache-Control', "max-age=86400, stale-while-revalidate=86400, stale-if-error=259200")
        res.json({ streams, message: "Wrong ID format, check manifest for errors" }); next()
      }
      return
    }

    console.log('Extra parameters:', res.locals.extraParams)
    animeIMDBIDPromise.then((imdbID) => {
      if (!imdbID || imdbID === "null") throw Error("No IMDB ID")
      let metaProm
      const cachedMeta = cache.getMetaCache(imdbID)
      if (cachedMeta) {
        console.log(`\x1b[32m[Cache Hit] Metadata for:\x1b[39m ${imdbID}`)
        metaProm = Promise.resolve(cachedMeta)
      } else if ((season) && (parseInt(season) === 0) && (req.params.type==="series")){
        console.log(`\x1b[33mGot a "special", searching Cinemeta with:`, imdbID, "to get the special's title:\x1b[39m")
        metaProm = Metadata.GetSpecialMeta(imdbID,episode)
      } else {
        console.log(`\x1b[33mGetting TMDB metadata for IMDB ID:\x1b[39m`, imdbID)
        metaProm = Metadata.GetTMDBMeta(imdbID).then((TMDBmeta) => {
          console.log('\x1b[36mGot TMDB metadata:\x1b[39m', TMDBmeta.shortPrint())
          cache.setMetaCache(imdbID, TMDBmeta)
          return TMDBmeta
        }).catch((reason) => {
          console.error("\x1b[31mDidn't get TMDB metadata because:\x1b[39m " + reason + ", \x1b[33mtrying Cinemeta...\x1b[39m")
          return Metadata.GetCinemetaMeta(imdbID, req.params.type).then((Cinemeta) => {
            console.log('\x1b[36mGot Cinemeta metadata:\x1b[39m', Cinemeta.shortPrint())
            cache.setMetaCache(imdbID, Cinemeta)
            return Cinemeta
          })
        })
      }
      
      return metaProm.catch((err) => {
        console.error('\x1b[31mFailed on metadata:\x1b[39m ' + err)
        if (!res.headersSent) {
          res.header('Cache-Control', "max-age=86400, stale-while-revalidate=86400, stale-if-error=259200")
          res.json({ streams, message: "Failed getting media info" })
          next()
        }
        throw err
      })
    }).then((metadata) => {
      const searchTerm = ((season) && (parseInt(season) !== 1) && (parseInt(season) !== 0)) ? `${metadata.title} ${season}` : metadata.title
      
      // 1. TioAnime
      const tioanimep = queryProvider("tioanime", enabledProviders, async () => {
        const cachedSlug = await cache.getSlugCache("tioanime", searchTerm)
        if (cachedSlug) {
          console.log(`\x1b[32m[Cache Hit] TioAnime slug:\x1b[39m ${cachedSlug}`)
          return tioanimeAPI.GetItemStreams(cachedSlug, streamOptions, episode)
        }
        return tioanimeAPI.SearchTioAnime(searchTerm, req.params.type).then((animeItems) => {
          if (!animeItems || animeItems.length === 0) return []
          const result = fuzzysort.go(searchTerm, animeItems, {key: 'title', limit: 1})[0]?.obj || animeItems[0]
          if (result?.slug) cache.setSlugCache("tioanime", searchTerm, result.slug)
          return tioanimeAPI.GetItemStreams(result.slug, streamOptions, episode)
        })
      })

      // 2. JKAnime
      const jkanimep = queryProvider("jkanime", enabledProviders, async () => {
        const cachedSlug = await cache.getSlugCache("jkanime", searchTerm)
        if (cachedSlug) {
          console.log(`\x1b[32m[Cache Hit] JKAnime slug:\x1b[39m ${cachedSlug}`)
          return jkanimeAPI.GetItemStreams(cachedSlug, streamOptions, episode)
        }
        return jkanimeAPI.SearchJKAnime(searchTerm).then((animeItems) => {
          if (!animeItems || animeItems.length === 0) return []
          const result = fuzzysort.go(searchTerm, animeItems, {key: 'title', limit: 1})[0]?.obj || animeItems[0]
          if (!result?.slug) return []
          cache.setSlugCache("jkanime", searchTerm, result.slug)
          return jkanimeAPI.GetItemStreams(result.slug, streamOptions, episode)
        })
      })

      // 3. AnimeFLV
      const animeFLVp = queryProvider("animeflv", enabledProviders, async () => {
        const cachedSlug = await cache.getSlugCache("animeflv", searchTerm)
        if (cachedSlug) {
          console.log(`\x1b[32m[Cache Hit] AnimeFLV slug:\x1b[39m ${cachedSlug}`)
          return animeFLVAPI.GetItemStreams(cachedSlug, streamOptions, episode)
        }
        return animeFLVAPI.SearchAnimeFLV(searchTerm).then((animeItems) => {
          if (!animeItems || animeItems.length === 0) return []
          const result = fuzzysort.go(searchTerm, animeItems, {key: 'title', limit: 1})[0]?.obj || animeItems[0]
          if (result?.slug) cache.setSlugCache("animeflv", searchTerm, result.slug)
          return animeFLVAPI.GetItemStreams(result.slug, streamOptions, episode)
        })
      })

      // 4. AnimeAV1
      const animeAV1p = queryProvider("animeav1", enabledProviders, async () => {
        const cachedSlug = await cache.getSlugCache("animeav1", searchTerm)
        if (cachedSlug) {
          console.log(`\x1b[32m[Cache Hit] AnimeAV1 slug:\x1b[39m ${cachedSlug}`)
          return animeAV1API.GetItemStreams(cachedSlug, streamOptions, episode)
        }
        return animeAV1API.SearchAnimeAV1(searchTerm, req.params.type).then((animeItems) => {
          if (!animeItems || animeItems.length === 0) return []
          const result = fuzzysort.go(searchTerm, animeItems, {key: 'title', limit: 1})[0]?.obj || animeItems[0]
          if (!result?.slug) return []
          cache.setSlugCache("animeav1", searchTerm, result.slug)
          return animeAV1API.GetItemStreams(result.slug, streamOptions, episode)
        })
      })

      // 5. Henaojara
      const henaojarap = queryProvider("henaojara", enabledProviders, async () => {
        const cachedSlug = await cache.getSlugCache("henaojara", searchTerm)
        if (cachedSlug) {
          console.log(`\x1b[32m[Cache Hit] Henaojara slug:\x1b[39m ${cachedSlug}`)
          return henaojaraAPI.GetItemStreams(cachedSlug, streamOptions, episode)
        }
        return henaojaraAPI.SearchHenaojara(searchTerm).then((animeItems) => {
          if (!animeItems || animeItems.length === 0) return []
          const result = fuzzysort.go(searchTerm, animeItems, {key: 'title', limit: 1})[0]?.obj || animeItems[0]
          if (result?.slug) cache.setSlugCache("henaojara", searchTerm, result.slug)
          return henaojaraAPI.GetItemStreams(result.slug, streamOptions, episode)
        })
      })

      // 6. AnimeJara
      const animejarap = queryProvider("animejara", enabledProviders, async () => {
        const cachedSlug = await cache.getSlugCache("animejara", searchTerm)
        if (cachedSlug) {
          console.log(`\x1b[32m[Cache Hit] AnimeJara slug:\x1b[39m ${cachedSlug}`)
          return animejaraAPI.GetItemStreams(cachedSlug, streamOptions, season, episode)
        }
        return animejaraAPI.SearchAnimeJara(searchTerm, req.params.type).then((animeItems) => {
          if (!animeItems || animeItems.length === 0) return []
          const result = fuzzysort.go(searchTerm, animeItems, {key: 'title', limit: 1})[0]?.obj || animeItems[0]
          if (result?.slug) cache.setSlugCache("animejara", searchTerm, result.slug)
          return animejaraAPI.GetItemStreams(result.slug, streamOptions, season, episode)
        })
      })

      const providerPromises = [tioanimep, jkanimep, animeFLVp, animeAV1p, henaojarap, animejarap]

      CombineStreams(providerPromises).then((combinedStreams) => {
        if (combinedStreams.length > 0) {
          console.log(`\x1b[36mGot ${combinedStreams.length} streams\x1b[39m`)
          cache.setStreamCache(cacheKey, combinedStreams)
          res.header('Cache-Control', "max-age=86400, stale-while-revalidate=86400, stale-if-error=259200")
          res.json({ streams: combinedStreams, message: "Got streams!" })
          next()
        } else {
          if (!res.headersSent) {
            res.header('Cache-Control', "max-age=86400, stale-while-revalidate=86400, stale-if-error=259200")
            res.json({ streams, message: "Failed getting streams" });
            next()
          }
        }
      })
    }).catch((err) => {
      console.error('\x1b[31mFailed on metadata search because:\x1b[39m ' + err)
      if (!res.headersSent) {
        res.header('Cache-Control', "max-age=86400, stale-while-revalidate=86400, stale-if-error=259200")
        res.json({ streams, message: "Failed getting media info" })
        next()
      }
    })
  }
}

/** 
 * Parses the extra config parameter we can get when the addon is configured
 */
function ParseConfig(req, res, next) {
  res.locals.config = new URLSearchParams(decodeURIComponent(req.params.config))
  console.log('Config parameters:', res.locals.config)
  next()
}

//Configured requests
stream.get("/:config/stream/:type/:videoId/*.json", ParseConfig, HandleLongStreamRequest, HandleStreamRequest)
stream.get("/:config/stream/:type/:videoId.json", ParseConfig, HandleStreamRequest)
//Unconfigured requests
stream.get("/stream/:type/:videoId/*.json", HandleLongStreamRequest, HandleStreamRequest)
stream.get("/stream/:type/:videoId.json", HandleStreamRequest)

/** 
 * Parses query params if provided
 */
function SearchParamsRegex(extraParams) {
  if (extraParams !== undefined) {
    const paramMap = new Map()
    const keyVals = extraParams.split('&');
    for (let keyVal of keyVals) {
      const keyValArr = keyVal.split('=')
      const param = keyValArr[0]; const val = keyValArr[1];
      paramMap.set(param, val)
    }
    return Object.fromEntries(paramMap)
  } else return {}
}

/**
 * Combines results and ranks:
 * 1. Debrid streams ([RD+], [AD+], [PM+], [DL+])
 * 2. In-app direct streams (mp4, hls)
 * 3. External browser redirects
 */
function CombineStreams(streamPromises) {
  return Promise.all(streamPromises).then((results) => {
    let combinedStreams = []
    for (const res of results) {
      if (Array.isArray(res) && res.length > 0) {
        combinedStreams = combinedStreams.concat(res)
      }
    }
    const isDebrid = (s) => s.name && s.name.startsWith("[") && s.name.includes("+]");
    const isInternalDirect = (s) => s.url && !isDebrid(s);
    const isExternal = (s) => !s.url;

    const debridStreams = combinedStreams.filter(isDebrid);
    const internalStreams = combinedStreams.filter(isInternalDirect);
    const externalStreams = combinedStreams.filter(isExternal);

    return debridStreams.concat(internalStreams).concat(externalStreams);
  })
}

module.exports = stream;