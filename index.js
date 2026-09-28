const express = require("express");
const https   = require("https");
const zlib    = require("zlib");

const app  = express();
const PORT = process.env.PORT || 3001;

// ── CORS ──────────────────────────────────────────────────────────────────────
app.use((req, res, next) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    if (req.method === "OPTIONS") return res.sendStatus(204);
    next();
});

app.use(express.text({ type: "text/plain" }));

// ── Generic HTTPS request helper ──────────────────────────────────────────────
function makeRequest(hostname, path, method, extraHeaders, body, redirectCount = 0) {
    return new Promise((resolve, reject) => {
        if (redirectCount > 5) return reject(new Error("Too many redirects"));
        const options = {
            hostname, port: 443, path, method,
            minVersion: "TLSv1.2", maxVersion: "TLSv1.3",
            rejectUnauthorized: true,
            headers: extraHeaders,
        };
        const req = https.request(options, (incoming) => {
            const { statusCode, headers } = incoming;
            if ([301, 302, 307, 308].includes(statusCode) && headers.location) {
                incoming.resume();
                const u = new URL(headers.location);
                return makeRequest(u.hostname, u.pathname + u.search, "GET", extraHeaders, null, redirectCount + 1)
                    .then(resolve).catch(reject);
            }
            resolve(incoming);
        });
        req.on("error", reject);
        if (body) req.write(body);
        req.end();
    });
}

function decompress(response) {
    const enc = response.headers["content-encoding"] || "";
    if (enc.includes("gzip"))    return response.pipe(zlib.createGunzip());
    if (enc.includes("deflate")) return response.pipe(zlib.createInflate());
    if (enc.includes("br"))      return response.pipe(zlib.createBrotliDecompress());
    return response;
}

function bodyToString(incoming) {
    return new Promise((resolve, reject) => {
        let data = "";
        decompress(incoming).on("data", c => data += c).on("end", () => resolve(data)).on("error", reject);
    });
}

// ── AnimeParadise: auto-fetch and cache the next-action hash ──────────────────
let apActionCache = {
    searchHash: null,
    watchHash: null,
    fetchedAt: 0,
};

async function getAPActions() {
    // Cache for 30 minutes — the hash only changes on their deploy
    if (apActionCache.searchHash && Date.now() - apActionCache.fetchedAt < 30 * 60 * 1000) {
        return apActionCache;
    }
    try {
        const html = await makeRequest("www.animeparadise.moe", "/search?page=1", "GET", {
            "User-Agent": "Mozilla/5.0 (X11; Linux x86_64; rv:140.0) Gecko/20100101 Firefox/140.0",
            "Accept": "text/html",
            "Accept-Encoding": "gzip, deflate",
        }, null).then(bodyToString);

        // Find all next-action hashes from inline JS: they're long hex strings bound to server actions
        const hashes = [...html.matchAll(/["']([a-f0-9]{40,})["']/gi)].map(m => m[1]);
        const unique = [...new Set(hashes)];

        // The search action is typically the first unique long hash
        // The watch action is usually a different one — both are in the page
        if (unique.length >= 1) {
            apActionCache = {
                searchHash: unique[0],
                watchHash:  unique[1] || unique[0],
                fetchedAt:  Date.now(),
            };
        }
    } catch (e) {
        console.warn("AP action fetch failed:", e.message);
    }
    return apActionCache;
}

// ── AnimeParadise search ─  POST /ap/search?q=bleach ─────────────────────────
app.get("/ap/search", async (req, res) => {
    const q = req.query.q;
    if (!q) return res.status(400).json({ error: "Missing q" });

    // Use hardcoded known-good hash as fallback; also try to auto-fetch
    const { searchHash } = await getAPActions();
    const actionHash = searchHash || "708838fdd26288675524861538242e1ccc0671b48c";

    const body = JSON.stringify([q, { genres: [], year: null, season: null, page: 1, limit: 25, sort: null }, "$undefined"]);

    try {
        const incoming = await makeRequest("www.animeparadise.moe", "/search?page=1", "POST", {
            "User-Agent":    "Mozilla/5.0 (X11; Linux x86_64; rv:140.0) Gecko/20100101 Firefox/140.0",
            "Accept":        "text/x-component",
            "Accept-Encoding": "gzip, deflate",
            "Content-Type":  "text/plain;charset=UTF-8",
            "next-action":   actionHash,
            "next-router-state-tree": encodeURIComponent(JSON.stringify(["",{"children":["search",{"children":["__PAGE__",{}]}]}])),
        }, body);

        const text = await bodyToString(incoming);
        // Parse the NDJSON response: line starting with "1:" has the data
        for (const line of text.split("\n")) {
            if (line.startsWith("1:")) {
                try {
                    const parsed = JSON.parse(line.slice(2));
                    return res.json(parsed);
                } catch {}
            }
        }
        res.status(502).json({ error: "Could not parse AP response" });
    } catch (err) {
        console.error("AP search error:", err.message);
        res.status(502).json({ error: "AP search failed" });
    }
});

// ── AnimeParadise stream ─ POST /ap/stream?uid=<uid>&origin=<_id> ─────────────
app.get("/ap/stream", async (req, res) => {
    const { uid, origin } = req.query;
    if (!uid || !origin) return res.status(400).json({ error: "Missing uid or origin" });
    if (!/^[a-z0-9-]+$/i.test(uid)) return res.status(400).json({ error: "Invalid uid" });

    const { watchHash } = await getAPActions();
    const actionHash = watchHash || "604982bef023a1ddf0c1c8fc7cdcf473df59ddeb64";
    const body = JSON.stringify([uid, origin]);

    try {
        const incoming = await makeRequest(
            "www.animeparadise.moe",
            `/watch/${uid}?origin=${origin}`,
            "POST",
            {
                "User-Agent":    "Mozilla/5.0 (X11; Linux x86_64; rv:140.0) Gecko/20100101 Firefox/140.0",
                "Accept":        "text/x-component",
                "Accept-Encoding": "gzip, deflate",
                "Content-Type":  "text/plain;charset=UTF-8",
                "next-action":   actionHash,
                "Referer":       `https://www.animeparadise.moe/watch/${uid}?origin=${origin}`,
            },
            body
        );

        const text = await bodyToString(incoming);
        // Line "1:" contains episode data with streamLink
        for (const line of text.split("\n")) {
            if (line.startsWith("1:")) {
                try {
                    const data = JSON.parse(line.slice(2));
                    const streamLink = data?.episode?.streamLink || null;
                    const episodeList = data?.episodeList || [];
                    // Extract subData from current episode — prefer vtt, fallback to ass
                    const subData = (data?.episode?.subData || []).map(s => ({
                        src:   s.src,
                        label: s.label,
                        type:  s.type,
                    }));
                    return res.json({ streamLink, episodeList, subData });
                } catch {}
            }
        }
        res.status(502).json({ error: "No stream data found" });
    } catch (err) {
        console.error("AP stream error:", err.message);
        res.status(502).json({ error: "AP stream failed" });
    }
});

// GET /ap/action-hash  — return current next-action hash so browser can POST directly
app.get("/ap/action-hash", async (req, res) => {
    const { watchHash } = await getAPActions();
    res.json({ watchHash: watchHash || "604982bef023a1ddf0c1c8fc7cdcf473df59ddeb64" });
});

// ─────────────────────────────────────────────────────────────────────────────
// Anikoto endpoints
// ─────────────────────────────────────────────────────────────────────────────

const AK_HEADERS = {
    "User-Agent":      "Mozilla/5.0 (X11; Linux x86_64; rv:140.0) Gecko/20100101 Firefox/140.0",
    "X-Requested-With": "XMLHttpRequest",
    "Accept":          "application/json, text/javascript, */*; q=0.01",
    "Referer":         "https://anikototv.to/",
};

// GET /ak/search?q=bleach
app.get("/ak/search", async (req, res) => {
    const q = req.query.q;
    if (!q) return res.status(400).json({ error: "Missing q" });
    try {
        const incoming = await makeRequest(
            "anikototv.to",
            `/ajax/anime/search?keyword=${encodeURIComponent(q)}`,
            "GET", AK_HEADERS, null
        );
        res.setHeader("Content-Type", "application/json");
        res.setHeader("Access-Control-Allow-Origin", "*");
        decompress(incoming).pipe(res);
    } catch (err) {
        res.status(502).json({ error: "AK search failed" });
    }
});

// GET /ak/episodes?id=6825  — episode list for an anime
app.get("/ak/episodes", async (req, res) => {
    const id = req.query.id;
    if (!id || !/^\d+$/.test(id)) return res.status(400).json({ error: "Invalid id" });
    try {
        const incoming = await makeRequest(
            "anikototv.to",
            `/ajax/episode/list/${id}`,
            "GET", AK_HEADERS, null
        );
        res.setHeader("Content-Type", "application/json");
        res.setHeader("Access-Control-Allow-Origin", "*");
        decompress(incoming).pipe(res);
    } catch (err) {
        res.status(502).json({ error: "AK episodes failed" });
    }
});

// GET /ak/servers?ids=<base64>  — server list for an episode
app.get("/ak/servers", async (req, res) => {
    const ids = req.query.ids;
    if (!ids) return res.status(400).json({ error: "Missing ids" });
    try {
        const incoming = await makeRequest(
            "anikototv.to",
            `/ajax/server/list?servers=${encodeURIComponent(ids)}`,
            "GET", AK_HEADERS, null
        );
        res.setHeader("Content-Type", "application/json");
        res.setHeader("Access-Control-Allow-Origin", "*");
        decompress(incoming).pipe(res);
    } catch (err) {
        res.status(502).json({ error: "AK servers failed" });
    }
});

// GET /ak/source?linkId=<base64>  — get embed URL for a server
app.get("/ak/source", async (req, res) => {
    const linkId = req.query.linkId;
    if (!linkId) return res.status(400).json({ error: "Missing linkId" });
    try {
        const incoming = await makeRequest(
            "anikototv.to",
            `/ajax/server?get=${encodeURIComponent(linkId)}`,
            "GET", { ...AK_HEADERS, "Referer": "https://anikototv.to/watch/" },
            null
        );
        const body = await bodyToString(incoming);
        // Returns {status:200, result:{url:"https://megaplay.buzz/stream/...", skip_data:{...}}}
        res.setHeader("Content-Type", "application/json");
        res.setHeader("Access-Control-Allow-Origin", "*");
        res.send(body);
    } catch (err) {
        res.status(502).json({ error: "AK source failed" });
    }
});

// GET /ak/page?slug=bleach-sennen-...  — anime watch page HTML (for data-id + meta)
app.get("/ak/page", async (req, res) => {
    const slug = req.query.slug;
    if (!slug || !/^[\w-]+$/.test(slug)) return res.status(400).json({ error: "Invalid slug" });
    try {
        const incoming = await makeRequest("anikototv.to", `/watch/${slug}`, "GET", {
            "User-Agent":      AK_HEADERS["User-Agent"],
            "Accept":          "text/html",
            "Accept-Encoding": "gzip, deflate",
            "Referer":         "https://anikototv.to/",
        }, null);
        res.setHeader("Content-Type", "text/html; charset=UTF-8");
        res.setHeader("Access-Control-Allow-Origin", "*");
        decompress(incoming).pipe(res);
    } catch (err) {
        res.status(502).json({ error: "AK page failed" });
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// AnimeHeaven endpoints (existing)
// ─────────────────────────────────────────────────────────────────────────────

const AH_HEADERS = {
    "User-Agent":     "Mozilla/5.0 (X11; Linux x86_64; rv:140.0) Gecko/20100101 Firefox/140.0",
    "Accept-Language": "en-US,en;q=0.5",
    "Referer":        "https://animeheaven.me/",
    "Connection":     "keep-alive",
};

function ahRequest(urlOrPath, extraHeaders = {}, redirectCount = 0) {
    return new Promise((resolve, reject) => {
        if (redirectCount > 5) return reject(new Error("Too many redirects"));
        let hostname = "animeheaven.me", path = urlOrPath;
        if (urlOrPath.startsWith("http")) {
            const u = new URL(urlOrPath);
            hostname = u.hostname;
            path = u.pathname + u.search;
        }
        const options = {
            hostname, port: 443, path, method: "GET",
            minVersion: "TLSv1.2", maxVersion: "TLSv1.3",
            rejectUnauthorized: true,
            headers: { ...AH_HEADERS, ...extraHeaders },
        };
        const req = https.request(options, (incoming) => {
            const { statusCode, headers } = incoming;
            if ([301, 302, 307, 308].includes(statusCode) && headers.location) {
                incoming.resume();
                return ahRequest(headers.location, extraHeaders, redirectCount + 1).then(resolve).catch(reject);
            }
            resolve(incoming);
        });
        req.on("error", reject);
        req.end();
    });
}

// GET /search?q=
app.get("/search", async (req, res) => {
    const q = req.query.q;
    if (!q) return res.status(400).json({ error: "Missing q" });
    try {
        const incoming = await ahRequest(`/fastsearch.php?xhr=1&s=${encodeURIComponent(q)}`, {
            Accept: "*/*", "Accept-Encoding": "gzip, deflate",
        });
        if (incoming.statusCode !== 200) return res.status(incoming.statusCode).json({ error: "Upstream error" });
        res.setHeader("Content-Type", "text/html; charset=UTF-8");
        decompress(incoming).pipe(res);
    } catch (err) {
        console.error("AH search error:", err.message);
        res.status(502).json({ error: "Failed to fetch from animeheaven" });
    }
});

// GET /anime?id=
app.get("/anime", async (req, res) => {
    const id = req.query.id;
    if (!id || !/^[a-z0-9]+$/i.test(id)) return res.status(400).json({ error: "Invalid id" });
    try {
        const incoming = await ahRequest(`/anime.php?${id}`, {
            Accept: "text/html,application/xhtml+xml", "Accept-Encoding": "gzip, deflate",
        });
        if (incoming.statusCode !== 200) return res.status(incoming.statusCode).json({ error: "Upstream error" });
        res.setHeader("Content-Type", "text/html; charset=UTF-8");
        decompress(incoming).pipe(res);
    } catch (err) {
        res.status(502).json({ error: "Failed to fetch anime detail" });
    }
});

// GET /image?src=
app.get("/image", async (req, res) => {
    const src = req.query.src;
    if (!src || !src.startsWith("/")) return res.status(400).json({ error: "Invalid src" });
    try {
        const incoming = await ahRequest(src, { Accept: "image/avif,image/webp,image/png,image/*;q=0.8" });
        if (incoming.statusCode !== 200) return res.status(incoming.statusCode).json({ error: "Upstream error" });
        res.setHeader("Content-Type", incoming.headers["content-type"] || "image/jpeg");
        res.setHeader("Cache-Control", "public, max-age=86400");
        incoming.pipe(res);
    } catch (err) {
        res.status(502).json({ error: "Failed to fetch image" });
    }
});

// GET /watch?id=   (AnimeHeaven gate.php)
app.get("/watch", async (req, res) => {
    const id = req.query.id;
    if (!id || !/^[a-f0-9]+$/i.test(id)) return res.status(400).json({ error: "Invalid id" });
    try {
        const incoming = await ahRequest("/gate.php", {
            Accept: "text/html,application/xhtml+xml", "Accept-Encoding": "gzip, deflate",
            Cookie: `key=${id}`, "Upgrade-Insecure-Requests": "1",
        });
        if (incoming.statusCode !== 200) return res.status(incoming.statusCode).json({ error: `Upstream ${incoming.statusCode}` });
        const html = await bodyToString(incoming);
        const m3u8   = html.match(/["'](https?:\/\/[^"']+\.m3u8[^"']*)['"]/i)?.[1];
        const mp4    = html.match(/["'](https?:\/\/[^"']+\.mp4[^"']*)['"]/i)?.[1];
        const file   = html.match(/file\s*:\s*["'](https?:\/\/[^"']+)['"]/i)?.[1];
        const iframe = html.match(/<iframe[^>]+src=["'](https?:\/\/[^"']+)['"]/i)?.[1];
        res.json({ videoUrl: m3u8 || file || mp4 || null, iframe: iframe || null });
    } catch (err) {
        res.status(502).json({ error: "Failed to fetch watch page" });
    }
});

// GET /stream?url=  (AnimeHeaven video proxy with range support)
app.get("/stream", async (req, res) => {
    const url = req.query.url;
    if (!url) return res.status(400).json({ error: "Missing url" });
    let parsed;
    try { parsed = new URL(url); } catch { return res.status(400).json({ error: "Invalid url" }); }
    if (!parsed.hostname.endsWith("animeheaven.me")) return res.status(403).json({ error: "Forbidden domain" });
    try {
        const extraHeaders = { Accept: "video/mp4,video/*;q=0.9,*/*;q=0.8", Referer: "https://animeheaven.me/" };
        if (req.headers["range"]) extraHeaders["Range"] = req.headers["range"];
        const incoming = await makeRequest(parsed.hostname, parsed.pathname + parsed.search, "GET", { ...AH_HEADERS, ...extraHeaders }, null);
        res.status(incoming.statusCode);
        ["content-type","content-length","content-range","accept-ranges","cache-control"].forEach(h => {
            if (incoming.headers[h]) res.setHeader(h, incoming.headers[h]);
        });
        res.setHeader("Access-Control-Allow-Origin", "*");
        incoming.pipe(res);
    } catch (err) {
        res.status(502).json({ error: "Stream failed" });
    }
});

// ── AnimParadise CDN proxy ────────────────────────────────────────────────────
// Both stream.animeparadise.moe/m3u8 and /captions block non-AP origins.
// ── AnimParadise CDN proxy ────────────────────────────────────────────────────
// stream.animeparadise.moe blocks non-AP origins — proxy with correct Referer

const AP_CDN_HEADERS = {
    "User-Agent": "Mozilla/5.0 (X11; Linux x86_64; rv:140.0) Gecko/20100101 Firefox/140.0",
    "Referer":    "https://www.animeparadise.moe/",
    "Origin":     "https://www.animeparadise.moe",
};

// GET /ap/m3u8?streamLink=<link>  — proxy HLS manifest with fresh fetch, rewrite segment URLs
// Also accepts: /ap/m3u8?url=<already-encoded-segment-url> for segment proxying
app.get("/ap/m3u8", async (req, res) => {
    const streamLink = req.query.streamLink;
    const segUrl     = req.query.url;

    if (!streamLink && !segUrl) return res.status(400).json({ error: "Missing streamLink or url" });

    // Build the path: if streamLink, call /m3u8?url=<streamLink>
    //                 if url (segment), call /m3u8?url=<url>
    const encodedParam = streamLink
        ? encodeURIComponent(streamLink)
        : encodeURIComponent(segUrl);

    try {
        const incoming = await makeRequest(
            "stream.animeparadise.moe",
            `/m3u8?url=${encodedParam}`,
            "GET", AP_CDN_HEADERS, null
        );
        res.status(incoming.statusCode);
        res.setHeader("Access-Control-Allow-Origin", "*");
        res.setHeader("Content-Type", incoming.headers["content-type"] || "application/x-mpegURL");

        if (incoming.statusCode === 200) {
            let body = "";
            const s = decompress(incoming);
            s.on("data", c => body += c);
            s.on("end", () => {
                // Rewrite relative /m3u8?url=<segUrl> → /ap/m3u8?url=<segUrl>
                // so HLS.js fetches segments through our proxy too
                body = body.replace(/^\/m3u8\?url=([^\s\r\n]+)/gm,
                    (_, u) => `/ap/m3u8?url=${u}`);
                res.send(body);
            });
            s.on("error", () => res.status(502).end());
        } else {
            incoming.pipe(res);
        }
    } catch (err) {
        console.error("AP m3u8 error:", err.message);
        res.status(502).json({ error: "AP m3u8 failed" });
    }
});

// GET /ap/captions?url=<encoded>  — proxy VTT subtitle files
app.get("/ap/captions", async (req, res) => {
    const url = req.query.url;
    if (!url) return res.status(400).json({ error: "Missing url" });

    try {
        const incoming = await makeRequest(
            "stream.animeparadise.moe",
            `/captions?url=${encodeURIComponent(url)}`,
            "GET", AP_CDN_HEADERS, null
        );
        res.status(incoming.statusCode);
        res.setHeader("Access-Control-Allow-Origin", "*");
        res.setHeader("Content-Type", incoming.headers["content-type"] || "text/vtt");
        decompress(incoming).pipe(res);
    } catch (err) {
        console.error("AP captions error:", err.message);
        res.status(502).json({ error: "AP captions failed" });
    }
});

// ── Health ────────────────────────────────────────────────────────────────────
app.get("/",       (_req, res) => res.json({ status: "ok", service: "anime-proxy" }));
app.head("/",      (_req, res) => res.sendStatus(200));
app.get("/health", (_req, res) => res.json({ status: "ok" }));
app.head("/health",(_req, res) => res.sendStatus(200));

app.listen(PORT, () => console.log(`Anime proxy running on port ${PORT}`));
