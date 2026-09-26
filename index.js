const express = require("express");
const https = require("https");
const zlib = require("zlib");

const app = express();
const PORT = process.env.PORT || 3001;

// Allow requests from any origin
app.use((req, res, next) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    if (req.method === "OPTIONS") return res.sendStatus(204);
    next();
});

const BASE_HEADERS = {
    "User-Agent":
        "Mozilla/5.0 (X11; Linux x86_64; rv:140.0) Gecko/20100101 Firefox/140.0",
    "Accept-Language": "en-US,en;q=0.5",
    "Referer": "https://animeheaven.me/",
    "Connection": "keep-alive",
};

// Wrapper around https.request that forces HTTP/1.1 via maxVersion trick
function animeRequest(path, extraHeaders = {}) {
    return new Promise((resolve, reject) => {
        const options = {
            hostname: "animeheaven.me",
            port: 443,
            path,
            method: "GET",
            // Forcing TLS options that result in HTTP/1.1 negotiation
            minVersion: "TLSv1.2",
            maxVersion: "TLSv1.3",
            // Disable session reuse which can trigger h2
            rejectUnauthorized: true,
            headers: {
                ...BASE_HEADERS,
                ...extraHeaders,
            },
        };

        const req = https.request(options, (incoming) => {
            resolve(incoming);
        });

        req.on("error", reject);
        req.end();
    });
}

// Decompress gzip/deflate response if needed
function decompress(response) {
    const encoding = response.headers["content-encoding"] || "";
    if (encoding.includes("gzip")) return response.pipe(zlib.createGunzip());
    if (encoding.includes("deflate")) return response.pipe(zlib.createInflate());
    if (encoding.includes("br")) return response.pipe(zlib.createBrotliDecompress());
    return response;
}

// GET /search?q=re+zero
app.get("/search", async (req, res) => {
    const q = req.query.q;
    if (!q) return res.status(400).json({ error: "Missing query param: q" });

    try {
        const path = `/fastsearch.php?xhr=1&s=${encodeURIComponent(q)}`;
        const incoming = await animeRequest(path, {
            Accept: "*/*",
            "Accept-Encoding": "gzip, deflate",
        });

        if (incoming.statusCode !== 200) {
            return res.status(incoming.statusCode).json({ error: "Upstream error" });
        }

        res.setHeader("Content-Type", "text/html; charset=UTF-8");
        decompress(incoming).pipe(res);
    } catch (err) {
        console.error("Search error:", err.message);
        res.status(502).json({ error: "Failed to fetch from animeheaven" });
    }
});

// GET /image?src=/image.php?7tc0j
app.get("/image", async (req, res) => {
    const src = req.query.src;
    if (!src) return res.status(400).json({ error: "Missing query param: src" });
    if (!src.startsWith("/")) return res.status(400).json({ error: "Invalid src" });

    try {
        const incoming = await animeRequest(src, {
            Accept: "image/avif,image/webp,image/png,image/*;q=0.8,*/*;q=0.5",
        });

        if (incoming.statusCode !== 200) {
            return res.status(incoming.statusCode).json({ error: "Upstream error" });
        }

        const contentType = incoming.headers["content-type"] || "image/jpeg";
        res.setHeader("Content-Type", contentType);
        res.setHeader("Cache-Control", "public, max-age=86400");
        // Images are not gzip-encoded by the server, pipe directly
        incoming.pipe(res);
    } catch (err) {
        console.error("Image error:", err.message);
        res.status(502).json({ error: "Failed to fetch image" });
    }
});

// Health check
app.get("/health", (_req, res) => res.json({ status: "ok" }));

app.listen(PORT, () => {
    console.log(`Anime proxy running on port ${PORT}`);
});
