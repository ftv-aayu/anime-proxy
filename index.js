const express = require("express");
const fetch = require("node-fetch");
const https = require("https");

const app = express();
const PORT = process.env.PORT || 3001;

// Allow requests from any origin (your Firebase-hosted frontend)
app.use((req, res, next) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    if (req.method === "OPTIONS") return res.sendStatus(204);
    next();
});

// Use an http agent that forces HTTP/1.1
const agent = new https.Agent({ allowH2: false });

const HEADERS = {
    "User-Agent":
        "Mozilla/5.0 (X11; Linux x86_64; rv:140.0) Gecko/20100101 Firefox/140.0",
    "Accept": "*/*",
    "Accept-Language": "en-US,en;q=0.5",
    "Referer": "https://animeheaven.me/",
};

// GET /search?q=re+zero
app.get("/search", async (req, res) => {
    const q = req.query.q;
    if (!q) return res.status(400).json({ error: "Missing query param: q" });

    try {
        const url = `https://animeheaven.me/fastsearch.php?xhr=1&s=${encodeURIComponent(q)}`;
        const response = await fetch(url, { headers: HEADERS, agent });
        const html = await response.text();
        res.setHeader("Content-Type", "text/html; charset=UTF-8");
        res.send(html);
    } catch (err) {
        console.error("Search error:", err.message);
        res.status(502).json({ error: "Failed to fetch from animeheaven" });
    }
});

// GET /image?src=/image.php?7tc0j
app.get("/image", async (req, res) => {
    const src = req.query.src;
    if (!src) return res.status(400).json({ error: "Missing query param: src" });

    // Only allow paths from animeheaven.me
    if (!src.startsWith("/")) {
        return res.status(400).json({ error: "Invalid src path" });
    }

    try {
        const url = `https://animeheaven.me${src}`;
        const response = await fetch(url, {
            headers: { ...HEADERS, Accept: "image/avif,image/webp,image/png,image/*;q=0.8" },
            agent,
        });
        const contentType = response.headers.get("content-type") || "image/jpeg";
        res.setHeader("Content-Type", contentType);
        // Cache images for 1 day
        res.setHeader("Cache-Control", "public, max-age=86400");
        response.body.pipe(res);
    } catch (err) {
        console.error("Image error:", err.message);
        res.status(502).json({ error: "Failed to fetch image" });
    }
});

// Health check for Render
app.get("/health", (_req, res) => res.json({ status: "ok" }));

app.listen(PORT, () => {
    console.log(`Anime proxy running on port ${PORT}`);
});
