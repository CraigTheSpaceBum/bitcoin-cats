// Bitcoin Cats platform viewer counts.
// Public response only; all provider credentials remain in Cloudflare Worker secrets.

const ALLOWED_ORIGINS = new Set([
  "https://bitcoin-cats.ca",
  "https://www.bitcoin-cats.ca"
]);

const TWITCH_LOGIN = "craigthespacebum";
const YOUTUBE_HANDLE = "@craigthespacebum";
const KICK_SLUG = "craigthespacebum";
const CACHE_SECONDS = 45;
const REQUEST_TIMEOUT_MS = 9000;

let twitchTokenCache = { token: "", expiresAt: 0 };
let kickTokenCache = { token: "", expiresAt: 0 };
let youtubeUploadsCache = { playlistId: "", expiresAt: 0 };

function jsonResponse(value, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      ...extraHeaders
    }
  });
}

async function fetchJson(url, init = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      ...init,
      signal: controller.signal,
      headers: {
        Accept: "application/json",
        ...(init.headers || {})
      }
    });
    if (!response.ok) {
      // Do not echo provider response bodies: they can contain account/API metadata.
      throw new Error("Provider API request failed with HTTP " + response.status + ".");
    }
    return await response.json();
  } catch (error) {
    if (error?.name === "AbortError") {
      throw new Error("Provider API request timed out.");
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function setupRequired(note) {
  return { status: "setup_required", viewerCount: null, streamTitle: "", note };
}

function unavailable(note) {
  return { status: "error", viewerCount: null, streamTitle: "", note };
}

function offline() {
  return { status: "offline", viewerCount: 0, streamTitle: "", note: "Channel is not live." };
}

function live(viewerCount, streamTitle = "", note = "") {
  const count = Number.isFinite(Number(viewerCount)) && viewerCount !== null && viewerCount !== undefined
    ? Number(viewerCount)
    : null;
  return {
    status: "live",
    viewerCount: count,
    streamTitle: String(streamTitle || ""),
    note: count === null ? (note || "Live, but the platform did not return a public viewer count.") : note
  };
}

async function getTwitchToken(env) {
  if (twitchTokenCache.token && twitchTokenCache.expiresAt > Date.now() + 60000) {
    return twitchTokenCache.token;
  }
  const body = new URLSearchParams({
    client_id: env.TWITCH_CLIENT_ID,
    client_secret: env.TWITCH_CLIENT_SECRET,
    grant_type: "client_credentials"
  });
  const data = await fetchJson("https://id.twitch.tv/oauth2/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body
  });
  if (!data.access_token) throw new Error("Twitch did not return an app access token.");
  twitchTokenCache = {
    token: data.access_token,
    expiresAt: Date.now() + Math.max(60, Number(data.expires_in || 3600)) * 1000
  };
  return twitchTokenCache.token;
}

async function getTwitchViewerCount(env) {
  if (!env.TWITCH_CLIENT_ID || !env.TWITCH_CLIENT_SECRET) {
    return setupRequired("Add TWITCH_CLIENT_ID and TWITCH_CLIENT_SECRET as Worker secrets.");
  }
  const token = await getTwitchToken(env);
  const url = new URL("https://api.twitch.tv/helix/streams");
  url.searchParams.set("user_login", TWITCH_LOGIN);
  url.searchParams.set("first", "1");
  const data = await fetchJson(url, {
    headers: {
      Authorization: "Bearer " + token,
      "Client-Id": env.TWITCH_CLIENT_ID
    }
  });
  const stream = Array.isArray(data.data) ? data.data[0] : null;
  return stream
    ? live(stream.viewer_count, stream.title)
    : offline();
}

async function getYoutubeUploadsPlaylist(env) {
  if (youtubeUploadsCache.playlistId && youtubeUploadsCache.expiresAt > Date.now()) {
    return youtubeUploadsCache.playlistId;
  }
  const url = new URL("https://www.googleapis.com/youtube/v3/channels");
  url.searchParams.set("part", "contentDetails");
  url.searchParams.set("forHandle", YOUTUBE_HANDLE);
  url.searchParams.set("key", env.YOUTUBE_API_KEY);
  const data = await fetchJson(url);
  const playlistId = data.items?.[0]?.contentDetails?.relatedPlaylists?.uploads;
  if (!playlistId) throw new Error("YouTube did not return the channel uploads playlist.");
  youtubeUploadsCache = { playlistId, expiresAt: Date.now() + 24 * 60 * 60 * 1000 };
  return playlistId;
}

async function getYoutubeViewerCount(env) {
  if (!env.YOUTUBE_API_KEY) {
    return setupRequired("Add YOUTUBE_API_KEY as a Worker secret.");
  }
  const uploadsPlaylistId = await getYoutubeUploadsPlaylist(env);
  const playlistUrl = new URL("https://www.googleapis.com/youtube/v3/playlistItems");
  playlistUrl.searchParams.set("part", "contentDetails");
  playlistUrl.searchParams.set("playlistId", uploadsPlaylistId);
  playlistUrl.searchParams.set("maxResults", "25");
  playlistUrl.searchParams.set("key", env.YOUTUBE_API_KEY);
  const playlist = await fetchJson(playlistUrl);
  const videoIds = (playlist.items || [])
    .map(item => item.contentDetails?.videoId)
    .filter(Boolean);
  if (!videoIds.length) return offline();

  const videosUrl = new URL("https://www.googleapis.com/youtube/v3/videos");
  videosUrl.searchParams.set("part", "snippet,liveStreamingDetails");
  videosUrl.searchParams.set("id", videoIds.join(","));
  videosUrl.searchParams.set("key", env.YOUTUBE_API_KEY);
  const videos = await fetchJson(videosUrl);
  const active = (videos.items || []).find(video => {
    const details = video.liveStreamingDetails || {};
    return video.snippet?.liveBroadcastContent === "live" ||
      (details.actualStartTime && !details.actualEndTime);
  });
  if (!active) return offline();

  const details = active.liveStreamingDetails || {};
  return live(details.concurrentViewers, active.snippet?.title,
    details.concurrentViewers === undefined
      ? "YouTube reports the stream as live, but its public concurrent-viewer count is hidden or unavailable."
      : "");
}

async function getKickToken(env) {
  if (kickTokenCache.token && kickTokenCache.expiresAt > Date.now() + 60000) {
    return kickTokenCache.token;
  }
  const body = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: env.KICK_CLIENT_ID,
    client_secret: env.KICK_CLIENT_SECRET
  });
  const data = await fetchJson("https://id.kick.com/oauth/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body
  });
  if (!data.access_token) throw new Error("Kick did not return an app access token.");
  kickTokenCache = {
    token: data.access_token,
    expiresAt: Date.now() + Math.max(60, Number(data.expires_in || 3600)) * 1000
  };
  return kickTokenCache.token;
}

async function getKickViewerCount(env) {
  if (!env.KICK_CLIENT_ID || !env.KICK_CLIENT_SECRET) {
    return setupRequired("Add KICK_CLIENT_ID and KICK_CLIENT_SECRET as Worker secrets.");
  }
  const token = await getKickToken(env);
  const url = new URL("https://api.kick.com/public/v1/channels");
  url.searchParams.set("slug", KICK_SLUG);
  const data = await fetchJson(url, {
    headers: { Authorization: "Bearer " + token }
  });
  const channel = Array.isArray(data.data) ? data.data[0] : null;
  if (!channel?.stream?.is_live) return offline();
  return live(channel.stream.viewer_count, channel.stream_title || "");
}

async function getRumbleViewerCount(env) {
  if (!env.RUMBLE_LIVE_API_URL) {
    return setupRequired("Add RUMBLE_LIVE_API_URL as a Worker secret. This is the private Live Stream API URL from your Rumble account.");
  }
  let apiUrl;
  try {
    apiUrl = new URL(env.RUMBLE_LIVE_API_URL);
    if (apiUrl.protocol !== "https:") throw new Error("HTTPS required.");
  } catch {
    throw new Error("The saved Rumble Live Stream API URL is invalid.");
  }
  const data = await fetchJson(apiUrl.toString());
  const streams = Array.isArray(data.livestreams) ? data.livestreams : [];
  const active = streams.filter(stream => stream && stream.is_live === true);
  if (!active.length) return offline();
  let total = 0;
  let hasCount = false;
  for (const stream of active) {
    const count = stream.watching_now;
    if (count !== null && count !== undefined && Number.isFinite(Number(count))) {
      total += Number(count);
      hasCount = true;
    }
  }
  const title = active.map(stream => stream.title).filter(Boolean).join(" · ");
  return live(hasCount ? total : null, title,
    hasCount ? "" : "Rumble reports a live stream, but did not return a public Watching Now count.");
}

async function safelyGet(fetcher, env) {
  try {
    return await fetcher(env);
  } catch (error) {
    return unavailable(String(error?.message || "Platform API request failed."));
  }
}

function buildTotal(platforms) {
  const allKnown = Object.values(platforms).every(platform =>
    platform.status === "offline" ||
    (platform.status === "live" && Number.isFinite(platform.viewerCount))
  );
  if (!allKnown) return null;
  return Object.values(platforms).reduce((sum, platform) => sum + platform.viewerCount, 0);
}

function addCors(response, origin) {
  const headers = new Headers(response.headers);
  if (origin && ALLOWED_ORIGINS.has(origin)) {
    headers.set("Access-Control-Allow-Origin", origin);
    headers.set("Vary", "Origin");
  }
  headers.set("X-Content-Type-Options", "nosniff");
  return new Response(response.body, { status: response.status, headers });
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const origin = request.headers.get("Origin") || "";

    if (origin && !ALLOWED_ORIGINS.has(origin)) {
      return jsonResponse({ error: "Origin not allowed." }, 403);
    }
    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          "Access-Control-Allow-Origin": origin || "https://bitcoin-cats.ca",
          "Access-Control-Allow-Methods": "GET, OPTIONS",
          "Access-Control-Allow-Headers": "Accept, Content-Type",
          "Access-Control-Max-Age": "86400",
          "Vary": "Origin"
        }
      });
    }
    if (request.method !== "GET") {
      return jsonResponse({ error: "Method not allowed." }, 405, { Allow: "GET, OPTIONS" });
    }
    if (url.pathname !== "/api/platform-viewers" && url.pathname !== "/api/platform-viewers/") {
      return jsonResponse({ error: "Not found." }, 404);
    }

    const cacheKey = new Request(url.origin + "/__internal/platform-viewers-v1", { method: "GET" });
    try {
      const cached = await caches.default.match(cacheKey);
      if (cached) return addCors(cached, origin);
    } catch {
      // Cache is an optimization; provider lookups still work if cache is unavailable.
    }

    const entries = await Promise.all([
      safelyGet(getTwitchViewerCount, env),
      safelyGet(getYoutubeViewerCount, env),
      safelyGet(getKickViewerCount, env),
      safelyGet(getRumbleViewerCount, env)
    ]);
    const platforms = {
      twitch: entries[0],
      youtube: entries[1],
      kick: entries[2],
      rumble: entries[3]
    };
    const payload = {
      ok: true,
      updatedAt: new Date().toISOString(),
      refreshAfterSeconds: CACHE_SECONDS,
      platforms,
      totalViewers: buildTotal(platforms),
      totalNote: "Counts are added together, not deduplicated across platforms."
    };
    const response = jsonResponse(payload, 200, {
      "Cache-Control": "public, max-age=30, s-maxage=" + CACHE_SECONDS
    });
    try {
      ctx.waitUntil(caches.default.put(cacheKey, response.clone()));
    } catch {
      // Do not fail a successful provider lookup if caching is unavailable.
    }
    return addCors(response, origin);
  }
};
