/**
 * server.js — MovieBox API scraper
 * Paste any MovieBox link in the UI. Server parses subjectId,
 * hits the API, returns detail + stream URLs.
 */
const express = require("express");
const axios = require("axios");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;

// ─────────────────────────────────────────────────────────
// CONFIG — mirror list. server rotates on failure.
// ─────────────────────────────────────────────────────────
const CONFIG = {
  // candidate API hosts — tried in order until one answers
  hosts: [
    "https://api3.aiv.movie",
    "https://api6.aiv.movie",
    "https://api.inmoviebox.com",
    "https://moviebox.ph",
  ],
  clientInfo:
    '{"package_name":"com.community.oneroom","version_name":"3.0.03.0522.03","version_code":3000305,"os":"android","os_version":"13","device_id":"' +
    "0".repeat(16) +
    '","install_id":"' +
    "0".repeat(16) +
    '","lang":"en"}',
  headers: {
    "User-Agent":
      "com.community.oneroom/3000305 (Linux; U; Android 13; en_US; Pixel 7; Build/TQ3A.230805.001)",
    "X-Client-Info": null, // filled at runtime
    Accept: "application/json",
    "Accept-Language": "en-US,en;q=0.9",
    "Content-Type": "application/json",
  },
  timeout: 20000,
  retries: 2,
};

CONFIG.headers["X-Client-Info"] = CONFIG.clientInfo;

let activeHost = CONFIG.hosts[0];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function apiCall(method, endpoint, { params, data } = {}) {
  const hosts = [activeHost, ...CONFIG.hosts.filter((h) => h !== activeHost)];
  for (const host of hosts) {
    for (let attempt = 0; attempt <= CONFIG.retries; attempt++) {
      try {
        const url = host + endpoint;
        const r = await axios({
          method,
          url,
          params,
          data,
          headers: { ...CONFIG.headers, Referer: host + "/" },
          timeout: CONFIG.timeout,
          validateStatus: () => true,
        });
        if (r.status === 200 && r.data) {
          activeHost = host;
          return r.data;
        }
      } catch (e) {
        /* try next */
      }
      await sleep(400 * (attempt + 1));
    }
  }
  return null;
}

// ─────────────────────────────────────────────────────────
// URL PARSER — pull subjectId out of any moviebox link
// ─────────────────────────────────────────────────────────
function parseMovieBoxUrl(input) {
  const s = String(input || "").trim();

  // bare numeric id
  if (/^\d+$/.test(s)) return { subjectId: s, type: "movie" };

  let u;
  try {
    u = new URL(s.startsWith("http") ? s : "https://" + s);
  } catch {
    return null;
  }

  // paths look like:
  //   /movie/<slug>-<id>
  //   /series/<slug>-<id>
  //   /detail/<id>
  //   ?subjectId=<id>  ?id=<id>
  const qId = u.searchParams.get("subjectId") || u.searchParams.get("id");
  if (qId && /^\d+$/.test(qId)) {
    const isSeries = /series|tv/i.test(u.pathname);
    return { subjectId: qId, type: isSeries ? "series" : "movie" };
  }

  const m = u.pathname.match(/(movie|series|detail|tv)[/-]([^/?#]+)/i);
  if (m) {
    const tail = m[2];
    const idMatch = tail.match(/(\d{4,})$/);
    if (idMatch) {
      const isSeries = /series|tv/i.test(m[1]);
      return { subjectId: idMatch[1], type: isSeries ? "series" : "movie" };
    }
  }

  return null;
}

// ─────────────────────────────────────────────────────────
// SEARCH
// ─────────────────────────────────────────────────────────
async function search(query, page = 1) {
  const data = await apiCall(
    "POST",
    "/wefeed-mobile-bff/subject-api/search/v2",
    {
      data: {
        keyword: query,
        page,
        perPage: 20,
        subjectType: 0,
      },
    }
  );

  const items =
    data?.data?.items ||
    data?.data?.subjects ||
    data?.items ||
    data?.results ||
    [];

  return items.map(normalizeItem);
}

function normalizeItem(it) {
  const s = it.subject || it;
  return {
    subjectId: String(s.subjectId || s.id || ""),
    title: s.title || s.name || "",
    year: String(s.releaseDate || s.year || "").slice(0, 4),
    poster: s.cover?.url || s.poster || s.image || null,
    rating: s.imdbRatingValue || s.rating || null,
    type: s.subjectType === 2 ? "series" : "movie",
    raw: s,
  };
}

// ─────────────────────────────────────────────────────────
// DETAIL + STREAMS
// ─────────────────────────────────────────────────────────
async function detail(subjectId, type = "movie") {
  const data = await apiCall(
    "GET",
    "/wefeed-mobile-bff/subject-api/get",
    { params: { subjectId } }
  );

  const s = data?.data?.subject || data?.data || {};
  const out = {
    subjectId: String(subjectId),
    title: s.title || s.name || "",
    year: String(s.releaseDate || "").slice(0, 4),
    poster: s.cover?.url || s.poster || null,
    synopsis: s.description || s.synopsis || "",
    rating: s.imdbRatingValue || null,
    genres: (s.genre || s.genres || []).map((g) => g.name || g),
    duration: s.duration || null,
    type,
    streams: [],
    seasons: [],
  };

  if (type === "series") {
    out.seasons = await fetchSeasons(subjectId);
  } else {
    out.streams = await fetchStreams(subjectId, 0, 0);
  }
  return out;
}

async function fetchSeasons(subjectId) {
  const data = await apiCall(
    "GET",
    "/wefeed-mobile-bff/subject-api/season-info",
    { params: { subjectId } }
  );
  const seasons = data?.data?.seasons || data?.data || [];
  return seasons.map((s, i) => ({
    season: s.season || i + 1,
    episodes: s.episodeCount || s.episodes?.length || 0,
    raw: s,
  }));
}

async function fetchStreams(subjectId, se, ep) {
  const data = await apiCall(
    "GET",
    "/wefeed-mobile-bff/subject-api/play-info",
    { params: { subjectId, se, ep } }
  );

  const streams = data?.data?.streams || data?.data?.playInfo || [];
  const out = [];

  for (const st of streams) {
    out.push({
      quality: st.resolution || st.quality || "?",
      url: st.url || st.playUrl || st.file,
      type: st.format || (st.url?.includes(".m3u8") ? "hls" : "mp4"),
    });
  }

  // fallback: dig raw JSON for any m3u8/mp4
  if (!out.length) {
    const blob = JSON.stringify(data);
    for (const m of blob.matchAll(/https?:\\?\/\\?\/[^"'\s]+\.(?:m3u8|mp4)[^"'\s]*/g)) {
      out.push({
        quality: "?",
        url: m[0].replace(/\\\//g, "/"),
        type: m[0].includes(".m3u8") ? "hls" : "mp4",
      });
    }
  }

  return out;
}

// ─────────────────────────────────────────────────────────
// ROUTES
// ─────────────────────────────────────────────────────────
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// main: paste a moviebox link (or id, or search text)
app.post("/api/resolve", async (req, res) => {
  const input = (req.body?.input || "").toString().trim();
  if (!input) return res.status(400).json({ error: "empty input" });

  try {
    const parsed = parseMovieBoxUrl(input);

    if (parsed) {
      const d = await detail(parsed.subjectId, parsed.type);
      return res.json({ mode: "detail", ...d });
    }

    // not a link → treat as search text
    const results = await search(input);
    res.json({ mode: "search", query: input, count: results.length, results });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/api/detail", async (req, res) => {
  const id = (req.query.id || "").toString();
  const type = (req.query.type || "movie").toString();
  if (!id) return res.status(400).json({ error: "missing id" });
  try {
    res.json(await detail(id, type));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/api/streams", async (req, res) => {
  const id = (req.query.id || "").toString();
  const se = parseInt(req.query.se || "0", 10);
  const ep = parseInt(req.query.ep || "0", 10);
  if (!id) return res.status(400).json({ error: "missing id" });
  try {
    res.json({ streams: await fetchStreams(id, se, ep) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/api/proxy", async (req, res) => {
  const url = (req.query.url || "").toString();
  if (!url) return res.status(400).send("missing url");
  try {
    const r = await axios.get(url, {
      responseType: "stream",
      headers: { "User-Agent": CONFIG.headers["User-Agent"] },
      timeout: CONFIG.timeout,
    });
    res.set("Access-Control-Allow-Origin", "*");
    r.data.pipe(res);
  } catch (e) {
    res.status(500).send(e.message);
  }
});

app.listen(PORT, () => {
  console.log(`[+] moviebox api scraper lit: http://localhost:${PORT}`);
  console.log(`[+] active host: ${activeHost}`);
});
