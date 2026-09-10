const express = require("express");
const router = express.Router();
const realdebrid = require("../lib/realdebrid.js");

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

async function handleResolve(apiKey, rawUrl, res) {
  if (!apiKey) {
    return res.status(400).send("Real-Debrid API key is required");
  }
  const targetUrl = decodeTargetUrl(rawUrl);
  if (!targetUrl) {
    return res.status(400).send("Invalid or missing target URL");
  }

  try {
    const rdData = await realdebrid.unrestrictLink(apiKey, targetUrl);
    console.log(`\x1b[32m[Real-Debrid] Redirecting to stream:\x1b[39m ${rdData.download}`);
    // 302 Redirect directly to Real-Debrid CDN
    return res.redirect(302, rdData.download);
  } catch (err) {
    console.error(`\x1b[31m[Real-Debrid] Resolution error:\x1b[39m ${err.message}`);
    return res.status(502).send(`Real-Debrid resolution error: ${err.message}`);
  }
}

// Route with path parameters (using base64url encoded target URL)
router.get("/rd/resolve/:apiKey/:encodedUrl", (req, res) => {
  return handleResolve(req.params.apiKey, req.params.encodedUrl, res);
});

// Route with query parameters
router.get("/rd/resolve", (req, res) => {
  return handleResolve(req.query.key || req.query.token, req.query.url, res);
});

module.exports = router;
