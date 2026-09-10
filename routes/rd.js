const express = require("express");
const router = express.Router();
const debrid = require("../lib/debrid.js");

function decodeTargetUrl(param) {
  if (!param) return null;
  // Check if it's base64url encoded
  try {
    const decoded = Buffer.from(param, "base64url").toString("utf8");
    if (decoded.startsWith("http://") || decoded.startsWith("https://")) {
      return decoded;
    }
  } catch (e) {}

  // Fallback to standard decodeURIComponent
  try {
    const decoded = decodeURIComponent(param);
    if (decoded.startsWith("http://") || decoded.startsWith("https://")) {
      return decoded;
    }
  } catch (e) {}

  return param;
}

async function handleResolve(provider, apiKey, rawUrl, res) {
  const provInfo = debrid.getProviderInfo(provider);
  if (!apiKey) {
    return res.status(400).send(`${provInfo.name} API key is required`);
  }
  const targetUrl = decodeTargetUrl(rawUrl);
  if (!targetUrl) {
    return res.status(400).send("Invalid or missing target URL");
  }

  try {
    const data = await debrid.unrestrictLink(provInfo.id, apiKey, targetUrl);
    console.log(`\x1b[32m[${provInfo.name}] Redirecting to stream:\x1b[39m ${data.download}`);
    // 302 Redirect directly to Debrid CDN
    return res.redirect(302, data.download);
  } catch (err) {
    console.error(`\x1b[31m[${provInfo.name}] Resolution error:\x1b[39m ${err.message}`);
    return res.status(502).send(`${provInfo.name} resolution error: ${err.message}`);
  }
}

// Multi-debrid routes
router.get("/debrid/resolve/:provider/:apiKey/:encodedUrl", (req, res) => {
  return handleResolve(req.params.provider, req.params.apiKey, req.params.encodedUrl, res);
});

router.get("/debrid/resolve", (req, res) => {
  const provider = req.query.provider || "rd";
  const apiKey = req.query.key || req.query.token;
  return handleResolve(provider, apiKey, req.query.url, res);
});

// Backward-compatible Real-Debrid routes
router.get("/rd/resolve/:apiKey/:encodedUrl", (req, res) => {
  return handleResolve("rd", req.params.apiKey, req.params.encodedUrl, res);
});

router.get("/rd/resolve", (req, res) => {
  return handleResolve("rd", req.query.key || req.query.token, req.query.url, res);
});

module.exports = router;
