// lib/realdebrid.js - Backward compatibility wrapper for lib/debrid.js
const debrid = require("./debrid.js");

module.exports = {
  isHostSupported: debrid.isHostSupported,
  normalizeUrl: debrid.normalizeUrl,
  unrestrictLink: (apiKey, link) => debrid.unrestrictLink("rd", apiKey, link),
  checkUser: async (apiKey) => {
    if (!apiKey) return { valid: false };
    try {
      const res = await fetch("https://api.real-debrid.com/rest/1.0/user", {
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
      return { valid: false };
    }
  }
};
