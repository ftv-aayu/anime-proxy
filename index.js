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

// Wrapper around https.request that forces HTTP/1.1 and follows redirects
function animeRequest(urlOrPath, extraHeaders = {}, redirectCount = 0) {
    return new Promise((resolve, reject) => {
        if (redirectCount > 5) return reject(new Error("Too many redirects"));

        // Accept full URL or just a path on animeheaven.me
        let hostname, path;
        if (urlOrPath.startsWith("http")) {
            const u = new URL(urlOrPath);
            hostname = u.hostname;
            path = u.pathname + u.search;
        } else {
            hostname = "animeheaven.me";
            path = urlOrPath;
        }

        const options = {
            hostname,
            port: 443,
            path,
            method: "GET",
            minVersion: "TLSv1.2",
            maxVersion: "TLSv1.3",
            rejectUnauthorized: true,
            headers: {
                ...BASE_HEADERS,
                ...extraHeaders,
            },
        };

        const req = https.request(options, (incoming) => {
            const { statusCode, headers } = incoming;
            // Follow 301/302/307/308 redirects
            if ([301, 302, 307, 308].includes(statusCode) && headers.location) {
                incoming.resume(); // drain the body
                return animeRequest(headers.location, extraHeaders, redirectCount + 1)
                    .then(resolve)
                    .catch(reject);
            }
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

// Like animeRequest but sends a cookie (for gate.php)
function animeRequestWithCookie(path, cookieValue, extraHeaders = {}) {
    return animeRequest(path, {
        ...extraHeaders,
        Cookie: `key=${cookieValue}`,
    });
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

// GET /anime?id=0ggzd  — fetches the anime detail page HTML
app.get("/anime", async (req, res) => {
    const id = req.query.id;
    if (!id) return res.status(400).json({ error: "Missing query param: id" });
    // Only allow alphanumeric IDs
    if (!/^[a-z0-9]+$/i.test(id)) return res.status(400).json({ error: "Invalid id" });

    try {
        const incoming = await animeRequest(`/anime.php?${id}`, {
            Accept: "text/html,application/xhtml+xml",
            "Accept-Encoding": "gzip, deflate",
            "Upgrade-Insecure-Requests": "1",
        });

        if (incoming.statusCode !== 200) {
            return res.status(incoming.statusCode).json({ error: "Upstream error" });
        }

        res.setHeader("Content-Type", "text/html; charset=UTF-8");
        decompress(incoming).pipe(res);
    } catch (err) {
        console.error("Anime detail error:", err.message);
        res.status(502).json({ error: "Failed to fetch anime detail" });
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

// Health check — supports both GET and HEAD (for UptimeRobot)
app.get("/", (_req, res) => res.json({ status: "ok", service: "anime-proxy" }));
app.head("/", (_req, res) => res.sendStatus(200));
app.get("/health", (_req, res) => res.json({ status: "ok" }));
app.head("/health", (_req, res) => res.sendStatus(200));

app.listen(PORT, () => {
    console.log(`Anime proxy running on port ${PORT}`);
});

// GET /watch?id=<gateId>  — fetches gate.php with the key cookie and extracts the video source
app.get("/watch", async (req, res) => {
    const id = req.query.id;
    if (!id || !/^[a-f0-9]+$/i.test(id)) return res.status(400).json({ error: "Invalid id" });

    try {
        const incoming = await animeRequestWithCookie("/gate.php", id, {
            Accept: "text/html,application/xhtml+xml",
            "Accept-Encoding": "gzip, deflate",
            "Upgrade-Insecure-Requests": "1",
        });

        if (incoming.statusCode !== 200) {
            return res.status(incoming.statusCode).json({ error: `Upstream ${incoming.statusCode}` });
        }

        let html = "";
        const stream = decompress(incoming);
        stream.on("data", c => html += c);
        stream.on("end", () => {
            // Extract video source — m3u8, mp4, or iframe
            const m3u8 = html.match(/["'](https?:\/\/[^"']+\.m3u8[^"']*)['"]/i)?.[1];
            const mp4  = html.match(/["'](https?:\/\/[^"']+\.mp4[^"']*)['"]/i)?.[1];
            const file = html.match(/file\s*:\s*["'](https?:\/\/[^"']+)['"]/i)?.[1];
            const iframe = html.match(/<iframe[^>]+src=["'](https?:\/\/[^"']+)['"]/i)?.[1];

            const videoUrl = m3u8 || file || mp4 || null;

            res.json({
                videoUrl,
                iframe: iframe || null,
                // send raw HTML so client can parse further if needed
                raw: html.length > 100 ? null : html,
            });
        });
    } catch (err) {
        console.error("Watch error:", err.message);
        res.status(502).json({ error: "Failed to fetch watch page" });
    }
});

// Temp debug: GET /fetch?path=/watch.php?xxx  — fetch any animeheaven path (remove in prod)
app.get("/fetch", async (req, res) => {
    const p = req.query.path;
    if (!p || !p.startsWith("/")) return res.status(400).json({ error: "bad path" });
    try {
        const incoming = await animeRequest(p, {
            Accept: "text/html,application/xhtml+xml",
            "Accept-Encoding": "gzip, deflate",
            "Upgrade-Insecure-Requests": "1",
        });
        res.setHeader("Content-Type", "text/html; charset=UTF-8");
        res.setHeader("X-Status", incoming.statusCode);
        decompress(incoming).pipe(res);
    } catch (err) {
        res.status(502).json({ error: err.message });
    }
});
