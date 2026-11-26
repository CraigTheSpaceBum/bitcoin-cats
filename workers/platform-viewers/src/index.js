// Bitcoin Cats platform data API.
// Provider credentials and Twitch OAuth tokens remain server-side in Cloudflare.

const ALLOWED_ORIGINS = new Set([
  "https://bitcoin-cats.ca",
  "https://www.bitcoin-cats.ca"
]);

const TWITCH_LOGIN = "craigthespacebum";
const YOUTUBE_HANDLE = "@craigthespacebum";
const TWITCH_OAUTH_REDIRECT = "https://api.bitcoin-cats.ca/api/twitch/callback";
const TWITCH_CHAT_KEY = "twitch:chat:events";
const TWITCH_AUTH_KEY = "twitch:auth";
const TWITCH_SECRET_KEY = "twitch:eventsub:secret";
const TWITCH_REQUIRED_SCOPES = ["user:read:chat", "moderator:read:followers"];
const KICK_SLUG = "craigthespacebum";
const KICK_CHAT_KEY = "kick:chat:events";
const KICK_WEBHOOK_URL = "https://api.bitcoin-cats.ca/api/kick/eventsub";
const KICK_EVENT_TYPES = [
  "chat.message.sent",
  "channel.followed",
  "channel.subscription.new",
  "channel.subscription.renewal",
  "channel.subscription.gifts",
  "kicks.gifted",
  "livestream.status.updated",
  "livestream.metadata.updated"
];
const CACHE_SECONDS = 45;
const REQUEST_TIMEOUT_MS = 9000;

let twitchTokenCache = { token: "", expiresAt: 0 };
let kickTokenCache = { token: "", expiresAt: 0 };
let kickPublicKeyCache = { key: null, expiresAt: 0 };
let kickSubscriptionsCache = { broadcasterId: "", status: null, expiresAt: 0 };
let youtubeUploadsCache = { playlistId: "", expiresAt: 0 };
let youtubeStatsCache = { value: null, expiresAt: 0 };

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

function htmlResponse(title, message, status = 200) {
  const safeTitle = String(title || "Twitch connection").replace(/[&<>"']/g, "");
  const safeMessage = String(message || "").replace(/[&<>"']/g, "");
  return new Response("<!doctype html><html lang=\"en\"><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"><title>" + safeTitle + "</title><body style=\"margin:0;background:#0b0b12;color:#f5f2fb;font:16px system-ui;padding:36px;line-height:1.6\"><main style=\"max-width:620px;margin:auto;background:#171724;border:1px solid #383447;border-radius:18px;padding:28px\"><h1 style=\"color:#ffad55;font-size:23px\">" + safeTitle + "</h1><p>" + safeMessage + "</p><p><a style=\"color:#ffbd79\" href=\"https://bitcoin-cats.ca/about\">Return to Bitcoin Cats</a></p></main></body></html>", {
    status,
    headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" }
  });
}

function toIso(value) {
  if (!value) return new Date().toISOString();
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? new Date().toISOString() : date.toISOString();
}

function makeRumbleEvents(data) {
  const events = [];
  const seen = new Set();
  const add = (row, kind, badge, amountLabel = "") => {
    if (!row || typeof row !== "object") return;
    const username = String(row.username || row.user || row.display_name || "Rumble user");
    const message = String(row.text || row.message || (kind === "subscriber" ? "Subscribed" : ""));
    const createdAt = toIso(row.created_on || row.created_at || row.subscribed_on || row.followed_on);
    const id = "rumble:" + kind + ":" + username + ":" + createdAt + ":" + message;
    if (seen.has(id)) return;
    seen.add(id);
    events.push({ id, createdAt, displayName: username, message, badge, amountLabel, source: "Rumble" });
  };
  for (const stream of (Array.isArray(data?.livestreams) ? data.livestreams : [])) {
    const chat = stream?.chat || {};
    for (const row of (chat.recent_messages || [])) add(row, "chat", "CHAT");
    if (chat.latest_message) add(chat.latest_message, "chat", "CHAT");
    for (const row of (chat.recent_rants || [])) {
      const dollars = row.amount_dollars ?? (row.amount_cents != null ? Number(row.amount_cents) / 100 : null);
      add(row, "rant", "RANT / DONATION", dollars == null ? "" : "$" + Number(dollars).toFixed(2));
    }
    if (chat.latest_rant) {
      const row = chat.latest_rant;
      const dollars = row.amount_dollars ?? (row.amount_cents != null ? Number(row.amount_cents) / 100 : null);
      add(row, "rant", "RANT / DONATION", dollars == null ? "" : "$" + Number(dollars).toFixed(2));
    }
  }
  const subscribers = data?.subscribers || {};
  for (const row of (subscribers.recent_subscribers || [])) add(row, "subscriber", "SUBSCRIBER");
  if (subscribers.latest_subscriber) add(subscribers.latest_subscriber, "subscriber", "SUBSCRIBER");
  return events.sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt)).slice(-50);
}

function normalizeYoutubeChatEvents(items) {
  return (Array.isArray(items) ? items : []).map(item => {
    const snippet = item.snippet || {};
    const author = item.authorDetails || {};
    const superChat = snippet.superChatDetails || snippet.superStickerDetails || null;
    const eventType = String(snippet.type || "textMessageEvent");
    const amountLabel = superChat && superChat.amountDisplayString ? String(superChat.amountDisplayString) : "";
    const badge = eventType === "superChatEvent" ? "SUPER CHAT" :
      eventType === "superStickerEvent" ? "SUPER STICKER" :
      eventType === "newSponsorEvent" ? "MEMBERSHIP" :
      eventType === "membershipGiftingEvent" ? "GIFTED MEMBERSHIPS" :
      eventType === "memberMilestoneChatEvent" ? "MEMBERSHIP MILESTONE" : "CHAT";
    const text = snippet.displayMessage ||
      snippet.textMessageDetails?.messageText ||
      snippet.memberMilestoneChatDetails?.userComment ||
      (eventType === "newSponsorEvent" ? "Joined the channel membership" : "") ||
      (eventType === "membershipGiftingEvent" ? "Gifted channel memberships" : "");
    return {
      id: "youtube:" + String(item.id || (snippet.publishedAt || "") + ":" + (author.displayName || "")),
      createdAt: toIso(snippet.publishedAt),
      displayName: String(author.displayName || "YouTube viewer"),
      avatar: String(author.profileImageUrl || ""),
      message: String(text || ""),
      badge,
      amountLabel,
      source: "YouTube"
    };
  }).filter(item => item.message || item.amountLabel);
}

async function getTwitchUserAuth(env) {
  if (!env.TWITCH_AUTH || !env.TWITCH_CLIENT_ID || !env.TWITCH_CLIENT_SECRET) return null;
  const saved = await env.TWITCH_AUTH.get(TWITCH_AUTH_KEY, "json");
  if (!saved?.accessToken || !saved?.refreshToken) return null;
  if (Number(saved.expiresAt || 0) > Date.now() + 90000) return saved;
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: saved.refreshToken,
    client_id: env.TWITCH_CLIENT_ID,
    client_secret: env.TWITCH_CLIENT_SECRET
  });
  const refreshed = await fetchJson("https://id.twitch.tv/oauth2/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body
  });
  if (!refreshed.access_token || !refreshed.refresh_token) throw new Error("Twitch authorization expired. Reconnect Twitch from the About page.");
  const updated = {
    ...saved,
    accessToken: refreshed.access_token,
    refreshToken: refreshed.refresh_token,
    expiresAt: Date.now() + Math.max(60, Number(refreshed.expires_in || 3600)) * 1000,
    scopes: Array.isArray(refreshed.scope) ? refreshed.scope : (saved.scopes || [])
  };
  await env.TWITCH_AUTH.put(TWITCH_AUTH_KEY, JSON.stringify(updated));
  return updated;
}

async function getTwitchFollowerCount(env) {
  if (!env.TWITCH_CLIENT_ID || !env.TWITCH_CLIENT_SECRET || !env.TWITCH_AUTH) {
    return { status: "setup_required", followerCount: null, note: "Add Twitch Worker credentials and authorize the broadcaster account." };
  }
  const auth = await getTwitchUserAuth(env);
  if (!auth) return { status: "setup_required", followerCount: null, note: "Authorize the Twitch broadcaster account from the About page." };
  if (!TWITCH_REQUIRED_SCOPES.every(scope => (auth.scopes || []).includes(scope))) {
    return { status: "setup_required", followerCount: null, note: "Reconnect Twitch and approve chat-read and follower-read permissions." };
  }
  const url = new URL("https://api.twitch.tv/helix/channels/followers");
  url.searchParams.set("broadcaster_id", auth.userId);
  url.searchParams.set("first", "1");
  const data = await fetchJson(url, {
    headers: { Authorization: "Bearer " + auth.accessToken, "Client-Id": env.TWITCH_CLIENT_ID }
  });
  return { status: "available", followerCount: Number.isFinite(Number(data.total)) ? Number(data.total) : null, note: "" };
}

async function getYoutubeFollowerCount(env) {
  if (!env.YOUTUBE_API_KEY) return { status: "setup_required", followerCount: null, note: "Add YOUTUBE_API_KEY to the Worker secrets." };
  if (youtubeStatsCache.value && youtubeStatsCache.expiresAt > Date.now()) return youtubeStatsCache.value;
  const url = new URL("https://www.googleapis.com/youtube/v3/channels");
  url.searchParams.set("part", "statistics");
  url.searchParams.set("forHandle", YOUTUBE_HANDLE);
  url.searchParams.set("key", env.YOUTUBE_API_KEY);
  const data = await fetchJson(url);
  const stats = data.items?.[0]?.statistics || {};
  let value;
  if (stats.hiddenSubscriberCount) {
    value = { status: "hidden", followerCount: null, note: "YouTube has hidden the public subscriber count." };
  } else if (stats.subscriberCount !== undefined && stats.subscriberCount !== null && Number.isFinite(Number(stats.subscriberCount))) {
    value = { status: "available", followerCount: Number(stats.subscriberCount), note: "" };
  } else {
    value = { status: "unavailable", followerCount: null, note: "YouTube did not return a subscriber count." };
  }
  youtubeStatsCache = { value, expiresAt: Date.now() + 60 * 60 * 1000 };
  return value;
}

async function beginTwitchAuthorization(env) {
  if (!env.TWITCH_CLIENT_ID || !env.TWITCH_CLIENT_SECRET || !env.TWITCH_AUTH) {
    return htmlResponse("Twitch setup is incomplete", "The Twitch application credentials and the Cloudflare TWITCH_AUTH storage binding must be configured before you can connect Twitch.", 503);
  }
  const stateBytes = new Uint8Array(24);
  crypto.getRandomValues(stateBytes);
  const state = Array.from(stateBytes, byte => byte.toString(16).padStart(2, "0")).join("");
  await env.TWITCH_AUTH.put("twitch:oauth-state:" + state, "pending", { expirationTtl: 600 });
  const url = new URL("https://id.twitch.tv/oauth2/authorize");
  url.searchParams.set("client_id", env.TWITCH_CLIENT_ID);
  url.searchParams.set("redirect_uri", TWITCH_OAUTH_REDIRECT);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", TWITCH_REQUIRED_SCOPES.join(" "));
  url.searchParams.set("state", state);
  return Response.redirect(url.toString(), 302);
}

async function ensureTwitchEventSubSubscriptions(env, auth, secret) {
  const headers = { Authorization: "Bearer " + auth.accessToken, "Client-Id": env.TWITCH_CLIENT_ID, "Content-Type": "application/json" };
  const listUrl = new URL("https://api.twitch.tv/helix/eventsub/subscriptions");
  listUrl.searchParams.set("user_id", auth.userId);
  const existingData = await fetchJson(listUrl, { headers });
  const existing = new Set((existingData.data || [])
    .filter(item => ["enabled", "webhook_callback_verification_pending"].includes(item.status))
    .map(item => item.type));
  const results = [];
  for (const type of ["channel.chat.message", "channel.chat.notification"]) {
    if (existing.has(type)) {
      results.push({ type, status: "already_subscribed" });
      continue;
    }
    try {
      await fetchJson("https://api.twitch.tv/helix/eventsub/subscriptions", {
        method: "POST",
        headers,
        body: JSON.stringify({
          type,
          version: "1",
          condition: { broadcaster_user_id: auth.userId, user_id: auth.userId },
          transport: { method: "webhook", callback: "https://api.bitcoin-cats.ca/api/twitch/eventsub", secret }
        })
      });
      results.push({ type, status: "verification_pending" });
    } catch (error) {
      results.push({ type, status: "error", note: String(error?.message || "Subscription request failed.") });
    }
  }
  return results;
}

async function completeTwitchAuthorization(request, env) {
  if (!env.TWITCH_CLIENT_ID || !env.TWITCH_CLIENT_SECRET || !env.TWITCH_AUTH) {
    return htmlResponse("Twitch setup is incomplete", "The Twitch application credentials or Cloudflare storage binding are missing.", 503);
  }
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  if (url.searchParams.has("error")) return htmlResponse("Twitch authorization cancelled", "Twitch did not authorize the Bitcoin Cats connection.", 400);
  if (!code || !state) return htmlResponse("Twitch authorization failed", "The Twitch callback did not include the expected authorization details.", 400);
  const stateKey = "twitch:oauth-state:" + state;
  const savedState = await env.TWITCH_AUTH.get(stateKey);
  if (!savedState) return htmlResponse("Twitch authorization expired", "Please return to the About page and start the Twitch connection again.", 400);
  await env.TWITCH_AUTH.delete(stateKey);
  const tokenBody = new URLSearchParams({
    client_id: env.TWITCH_CLIENT_ID,
    client_secret: env.TWITCH_CLIENT_SECRET,
    code,
    grant_type: "authorization_code",
    redirect_uri: TWITCH_OAUTH_REDIRECT
  });
  const tokens = await fetchJson("https://id.twitch.tv/oauth2/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: tokenBody
  });
  if (!tokens.access_token || !tokens.refresh_token) return htmlResponse("Twitch token exchange failed", "Twitch did not return the expected authorization tokens.", 502);
  const validation = await fetchJson("https://id.twitch.tv/oauth2/validate", {
    headers: { Authorization: "OAuth " + tokens.access_token }
  });
  const login = String(validation.login || "").toLowerCase();
  if (login !== TWITCH_LOGIN) {
    return htmlResponse("Wrong Twitch account", "Please authorize the Twitch account craigthespacebum, then try again.", 403);
  }
  const scopes = Array.isArray(validation.scopes) ? validation.scopes : (Array.isArray(tokens.scope) ? tokens.scope : []);
  if (!TWITCH_REQUIRED_SCOPES.every(scope => scopes.includes(scope))) {
    return htmlResponse("Twitch permissions missing", "Reconnect Twitch and approve both requested permissions: chat read and follower count read.", 403);
  }
  const auth = {
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token,
    expiresAt: Date.now() + Math.max(60, Number(tokens.expires_in || 3600)) * 1000,
    userId: String(validation.user_id || ""),
    login,
    scopes,
    connectedAt: new Date().toISOString()
  };
  await env.TWITCH_AUTH.put(TWITCH_AUTH_KEY, JSON.stringify(auth));
  let secret = await env.TWITCH_AUTH.get(TWITCH_SECRET_KEY);
  if (!secret) {
    const bytes = new Uint8Array(32);
    crypto.getRandomValues(bytes);
    secret = Array.from(bytes, byte => byte.toString(16).padStart(2, "0")).join("");
    await env.TWITCH_AUTH.put(TWITCH_SECRET_KEY, secret);
  }
  const subscriptions = await ensureTwitchEventSubSubscriptions(env, auth, secret);
  await env.TWITCH_AUTH.put("twitch:connection-status", JSON.stringify({
    connected: true,
    login,
    subscriptions,
    updatedAt: new Date().toISOString()
  }));
  return htmlResponse("Twitch connected", "The Twitch broadcaster account is authorized. Chat messages and chat notifications are being registered; Twitch may take a short moment to verify the webhook. You can return to the Live page now.");
}

function bytesToHex(bytes) {
  return Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2, "0")).join("");
}

async function verifyTwitchWebhook(request, rawBody, env) {
  if (!env.TWITCH_AUTH) return false;
  const secret = await env.TWITCH_AUTH.get(TWITCH_SECRET_KEY);
  if (!secret) return false;
  const messageId = request.headers.get("Twitch-Eventsub-Message-Id") || "";
  const timestamp = request.headers.get("Twitch-Eventsub-Message-Timestamp") || "";
  const signature = request.headers.get("Twitch-Eventsub-Message-Signature") || "";
  const timestampMs = Date.parse(timestamp);
  if (!messageId || !Number.isFinite(timestampMs) || Math.abs(Date.now() - timestampMs) > 10 * 60 * 1000 || !signature.startsWith("sha256=")) return false;
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const digest = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(messageId + timestamp + rawBody));
  const expected = "sha256=" + bytesToHex(digest);
  if (expected.length !== signature.length) return false;
  let mismatch = 0;
  for (let index = 0; index < expected.length; index++) mismatch |= expected.charCodeAt(index) ^ signature.charCodeAt(index);
  return mismatch === 0;
}

function normalizeTwitchEvent(subscriptionType, event, messageId) {
  const noticeType = String(event.notice_type || "").toLowerCase();
  if (subscriptionType === "channel.chat.message") {
    const bits = Number(event.cheer?.bits || 0);
    return {
      id: "twitch:" + messageId,
      source: "Twitch",
      createdAt: toIso(event.message?.sent_at || event.sent_at),
      displayName: String(event.chatter_user_name || event.chatter_user_login || "Twitch viewer"),
      message: String(event.message?.text || ""),
      badge: bits > 0 ? "BITS CHEER" : "CHAT",
      amountLabel: bits > 0 ? bits.toLocaleString() + " Bits" : ""
    };
  }
  const noticeLabels = {
    sub: "SUBSCRIPTION",
    resub: "RESUBSCRIPTION",
    sub_gift: "GIFTED SUB",
    community_sub_gift: "COMMUNITY GIFT",
    gift_paid_upgrade: "GIFT UPGRADE",
    prime_paid_upgrade: "PRIME UPGRADE",
    raid: "RAID",
    charity_donation: "CHARITY DONATION",
    bits_badge_tier: "BITS CHEER",
    announcement: "ANNOUNCEMENT"
  };
  const params = event.notice_params || {};
  const amountLabel = params.bits ? Number(params.bits).toLocaleString() + " Bits" :
    (params.gift_count ? String(params.gift_count) + " gifts" : "");
  const body = event.message?.text || event.system_message || (
    noticeType ? noticeType.replace(/_/g, " ") : "Twitch notification"
  );
  return {
    id: "twitch:" + messageId,
    source: "Twitch",
    createdAt: toIso(event.sent_at || event.message?.sent_at),
    displayName: String(event.chatter_user_name || event.user_name || event.chatter_user_login || "Twitch"),
    message: String(body),
    badge: noticeLabels[noticeType] || "TWITCH EVENT",
    amountLabel
  };
}

async function saveTwitchEvent(env, item) {
  if (!env.TWITCH_AUTH) return;
  const previous = await env.TWITCH_AUTH.get(TWITCH_CHAT_KEY, "json") || [];
  const combined = [...previous.filter(row => row.id !== item.id), item]
    .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt))
    .slice(-50);
  await env.TWITCH_AUTH.put(TWITCH_CHAT_KEY, JSON.stringify(combined), { expirationTtl: 60 * 60 * 24 * 14 });
}

async function handleTwitchEventSub(request, env) {
  const rawBody = await request.text();
  if (!(await verifyTwitchWebhook(request, rawBody, env))) return jsonResponse({ error: "Invalid EventSub signature." }, 403);
  let payload;
  try { payload = JSON.parse(rawBody); } catch { return jsonResponse({ error: "Invalid JSON." }, 400); }
  const messageType = request.headers.get("Twitch-Eventsub-Message-Type") || "";
  if (messageType === "webhook_callback_verification") {
    return new Response(String(payload.challenge || ""), { status: 200, headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" } });
  }
  if (messageType === "notification") {
    const type = payload.subscription?.type || "";
    const item = normalizeTwitchEvent(type, payload.event || {}, request.headers.get("Twitch-Eventsub-Message-Id") || crypto.randomUUID());
    if (item.message || item.amountLabel) await saveTwitchEvent(env, item);
    return new Response(null, { status: 204 });
  }
  if (messageType === "revocation") {
    if (env.TWITCH_AUTH) await env.TWITCH_AUTH.put("twitch:connection-status", JSON.stringify({ connected: false, reason: payload.subscription?.status || "revoked", updatedAt: new Date().toISOString() }));
    return new Response(null, { status: 204 });
  }
  return new Response(null, { status: 204 });
}

async function getTwitchChatMessages(env) {
  if (!env.TWITCH_AUTH) return { status: "setup_required", messages: [] };
  const auth = await getTwitchUserAuth(env);
  if (!auth) return { status: "setup_required", messages: [] };
  const messages = await env.TWITCH_AUTH.get(TWITCH_CHAT_KEY, "json") || [];
  return { status: "connected", messages: messages.slice(-50) };
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
  if (!env.YOUTUBE_API_KEY) return setupRequired("Add YOUTUBE_API_KEY as a Worker secret.");
  const uploadsPlaylistId = await getYoutubeUploadsPlaylist(env);
  const playlistUrl = new URL("https://www.googleapis.com/youtube/v3/playlistItems");
  playlistUrl.searchParams.set("part", "contentDetails");
  playlistUrl.searchParams.set("playlistId", uploadsPlaylistId);
  playlistUrl.searchParams.set("maxResults", "25");
  playlistUrl.searchParams.set("key", env.YOUTUBE_API_KEY);
  const playlist = await fetchJson(playlistUrl);
  const videoIds = (playlist.items || []).map(item => item.contentDetails?.videoId).filter(Boolean);
  if (!videoIds.length) return offline();

  const videosUrl = new URL("https://www.googleapis.com/youtube/v3/videos");
  videosUrl.searchParams.set("part", "snippet,liveStreamingDetails");
  videosUrl.searchParams.set("id", videoIds.join(","));
  videosUrl.searchParams.set("key", env.YOUTUBE_API_KEY);
  const videos = await fetchJson(videosUrl);
  const active = (videos.items || []).find(video => {
    const details = video.liveStreamingDetails || {};
    return video.snippet?.liveBroadcastContent === "live" || (details.actualStartTime && !details.actualEndTime);
  });
  if (!active) return offline();

  const details = active.liveStreamingDetails || {};
  let recentEvents = [];
  if (details.activeLiveChatId) {
    try {
      const chatUrl = new URL("https://www.googleapis.com/youtube/v3/liveChat/messages");
      chatUrl.searchParams.set("part", "id,snippet,authorDetails");
      chatUrl.searchParams.set("liveChatId", details.activeLiveChatId);
      chatUrl.searchParams.set("maxResults", "50");
      chatUrl.searchParams.set("key", env.YOUTUBE_API_KEY);
      const chat = await fetchJson(chatUrl);
      recentEvents = normalizeYoutubeChatEvents(chat.items);
    } catch (error) {
      // Live-chat access is optional; a disabled or unavailable chat must not hide the stream viewer count.
      console.warn("YouTube live chat is unavailable", String(error?.message || ""));
    }
  }
  return {
    ...live(details.concurrentViewers, active.snippet?.title,
      details.concurrentViewers === undefined
        ? "YouTube reports the stream as live, but its public concurrent-viewer count is hidden or unavailable."
        : ""),
    recentEvents
  };
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

async function ensureKickEventSubscriptions(env, broadcasterId, token) {
  if (!env.TWITCH_AUTH || !broadcasterId) return { status: "setup_required" };
  if (kickSubscriptionsCache.broadcasterId === String(broadcasterId) && kickSubscriptionsCache.expiresAt > Date.now()) {
    return kickSubscriptionsCache.status;
  }
  const headers = { Authorization: "Bearer " + token, "Content-Type": "application/json" };
  const listUrl = new URL("https://api.kick.com/public/v1/events/subscriptions");
  listUrl.searchParams.set("broadcaster_user_id", String(broadcasterId));
  const existingData = await fetchJson(listUrl, { headers });
  const existing = new Set((existingData.data || []).filter(item => item.method === "webhook").map(item => item.event));
  const missing = KICK_EVENT_TYPES.filter(name => !existing.has(name));
  let registration = [];
  if (missing.length) {
    const result = await fetchJson("https://api.kick.com/public/v1/events/subscriptions", {
      method: "POST",
      headers,
      body: JSON.stringify({
        broadcaster_user_id: Number(broadcasterId),
        method: "webhook",
        events: missing.map(name => ({ name, version: 1 }))
      })
    });
    registration = Array.isArray(result.data) ? result.data : [];
  }
  const hasErrors = registration.some(item => item.error);
  const status = {
    status: hasErrors ? "setup_required" : "connected",
    events: KICK_EVENT_TYPES.map(name => ({
      name,
      state: existing.has(name) ? "already_subscribed" :
        (registration.find(item => item.name === name)?.error ? "error" : "requested")
    }))
  };
  await env.TWITCH_AUTH.put("kick:connection-status", JSON.stringify(status), { expirationTtl: 60 * 60 * 24 });
  kickSubscriptionsCache = {
    broadcasterId: String(broadcasterId),
    status,
    expiresAt: Date.now() + 60 * 60 * 1000
  };
  return status;
}

async function getKickPublicKey() {
  if (kickPublicKeyCache.key && kickPublicKeyCache.expiresAt > Date.now()) return kickPublicKeyCache.key;
  const payload = await fetchJson("https://api.kick.com/public/v1/public-key");
  const pem = payload.data?.public_key || payload.public_key || "";
  if (!pem) throw new Error("Kick did not provide its webhook public key.");
  const base64 = String(pem).replace(/-----BEGIN PUBLIC KEY-----|-----END PUBLIC KEY-----|\\s/g, "");
  const der = Uint8Array.from(atob(base64), character => character.charCodeAt(0));
  const key = await crypto.subtle.importKey(
    "spki",
    der,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["verify"]
  );
  kickPublicKeyCache = { key, expiresAt: Date.now() + 60 * 60 * 1000 };
  return key;
}

async function verifyKickWebhook(request, rawBody) {
  const messageId = request.headers.get("Kick-Event-Message-Id") || "";
  const timestamp = request.headers.get("Kick-Event-Message-Timestamp") || "";
  const signature = request.headers.get("Kick-Event-Signature") || "";
  const timestampMs = Date.parse(timestamp);
  if (!messageId || !Number.isFinite(timestampMs) || Math.abs(Date.now() - timestampMs) > 10 * 60 * 1000 || !signature) return false;
  const publicKey = await getKickPublicKey();
  let signatureBytes;
  try {
    signatureBytes = Uint8Array.from(atob(signature), character => character.charCodeAt(0));
  } catch {
    return false;
  }
  const signed = messageId + "." + timestamp + "." + rawBody;
  return crypto.subtle.verify(
    "RSASSA-PKCS1-v1_5",
    publicKey,
    signatureBytes,
    new TextEncoder().encode(signed)
  );
}

function normalizeKickEvent(type, event, messageId, timestamp) {
  const author = event.sender || event.follower || event.subscriber || event.gifter ||
    event.redeemer || event.sender || event.broadcaster || {};
  const createdAt = toIso(event.created_at || event.redeemed_at || event.started_at || timestamp);
  const labels = {
    "chat.message.sent": "CHAT",
    "channel.followed": "NEW FOLLOWER",
    "channel.subscription.new": "NEW SUBSCRIBER",
    "channel.subscription.renewal": "SUBSCRIPTION RENEWED",
    "channel.subscription.gifts": "GIFTED SUBSCRIPTIONS",
    "kicks.gifted": "KICKS GIFT",
    "channel.reward.redemption.updated": "CHANNEL REWARD",
    "livestream.status.updated": "STREAM STATUS",
    "livestream.metadata.updated": "STREAM UPDATE"
  };
  let message = "";
  let amountLabel = "";
  let displayName = String(author.username || "Kick user");
  let avatar = String(author.profile_picture || "");
  switch (type) {
    case "chat.message.sent":
      message = String(event.content || "");
      break;
    case "channel.followed":
      message = "Followed the channel";
      break;
    case "channel.subscription.new":
      message = "Subscribed to the channel";
      break;
    case "channel.subscription.renewal":
      message = "Renewed their subscription";
      if (event.duration) amountLabel = String(event.duration) + " months";
      break;
    case "channel.subscription.gifts": {
      const count = Array.isArray(event.giftees) ? event.giftees.length : 0;
      message = count ? "Gifted " + count + " subscription" + (count === 1 ? "" : "s") : "Gifted subscriptions";
      if (count) amountLabel = String(count) + " gifts";
      displayName = String(event.gifter?.username || "Anonymous gifter");
      avatar = String(event.gifter?.profile_picture || "");
      break;
    }
    case "kicks.gifted":
      message = String(event.gift?.message || "Sent KICKs");
      if (event.gift?.amount !== undefined) amountLabel = Number(event.gift.amount).toLocaleString() + " KICKs";
      displayName = String(event.sender?.username || "Kick viewer");
      avatar = String(event.sender?.profile_picture || "");
      break;
    case "channel.reward.redemption.updated":
      message = "Redeemed " + String(event.reward?.title || "a channel reward");
      if (event.user_input) message += ": " + String(event.user_input);
      break;
    case "livestream.status.updated":
      message = event.is_live ? "Stream is now live" : "Stream ended";
      break;
    case "livestream.metadata.updated":
      message = "Stream details updated";
      if (event.metadata?.title) amountLabel = String(event.metadata.title);
      break;
    default:
      message = "";
  }
  if (!message && !amountLabel) return null;
  return {
    id: "kick:" + String(messageId || crypto.randomUUID()),
    source: "Kick",
    createdAt,
    displayName,
    avatar,
    message,
    badge: labels[type] || "KICK EVENT",
    amountLabel
  };
}

async function saveKickEvent(env, item) {
  if (!env.TWITCH_AUTH) return;
  const previous = await env.TWITCH_AUTH.get(KICK_CHAT_KEY, "json") || [];
  const combined = [...previous.filter(row => row.id !== item.id), item]
    .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt))
    .slice(-50);
  await env.TWITCH_AUTH.put(KICK_CHAT_KEY, JSON.stringify(combined), { expirationTtl: 60 * 60 * 24 * 14 });
}

async function handleKickEventSub(request, env) {
  const rawBody = await request.text();
  let verified = false;
  try {
    verified = await verifyKickWebhook(request, rawBody);
  } catch (error) {
    console.warn("Kick webhook verification failed", String(error?.message || ""));
  }
  if (!verified) return jsonResponse({ error: "Invalid Kick webhook signature." }, 403);
  let payload;
  try { payload = JSON.parse(rawBody); } catch { return jsonResponse({ error: "Invalid JSON." }, 400); }
  const type = request.headers.get("Kick-Event-Type") || "";
  const version = request.headers.get("Kick-Event-Version") || "";
  const messageId = request.headers.get("Kick-Event-Message-Id") || "";
  const timestamp = request.headers.get("Kick-Event-Message-Timestamp") || "";
  if (version !== "1") return new Response(null, { status: 204 });
  const item = normalizeKickEvent(type, payload, messageId, timestamp);
  if (item) await saveKickEvent(env, item);
  return new Response(null, { status: 204 });
}

async function getKickChatMessages(env) {
  if (!env.KICK_CLIENT_ID || !env.KICK_CLIENT_SECRET || !env.TWITCH_AUTH) {
    return { status: "setup_required", messages: [] };
  }
  const [messages, connection] = await Promise.all([
    env.TWITCH_AUTH.get(KICK_CHAT_KEY, "json"),
    env.TWITCH_AUTH.get("kick:connection-status", "json")
  ]);
  return {
    status: connection?.status || "setup_required",
    messages: Array.isArray(messages) ? messages.slice(-50) : [],
    note: connection?.status === "connected" ? "" : "Set the Kick webhook URL in the Developer app settings; the Worker registers event subscriptions when its API credentials are present."
  };
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
  if (channel?.broadcaster_user_id) {
    try {
      await ensureKickEventSubscriptions(env, channel.broadcaster_user_id, token);
    } catch (error) {
      console.warn("Could not register Kick webhook events", String(error?.message || ""));
    }
  }
  if (!channel?.stream?.is_live) return offline();
  return live(channel.stream.viewer_count, channel.stream_title || "");
}

async function getRumbleViewerCount(env) {
  if (!env.RUMBLE_LIVE_API_URL) {
    return {
      ...setupRequired("Add RUMBLE_LIVE_API_URL as a Worker secret. This is the private Live Stream API URL from your Rumble account."),
      followerCount: null,
      recentEvents: []
    };
  }
  let apiUrl;
  try {
    apiUrl = new URL(env.RUMBLE_LIVE_API_URL);
    if (apiUrl.protocol !== "https:") throw new Error("HTTPS required.");
  } catch {
    throw new Error("The saved Rumble Live Stream API URL is invalid.");
  }
  const data = await fetchJson(apiUrl.toString());
  const rawFollowerCount = data.followers?.num_followers_total;
  const followerCount = rawFollowerCount !== null && rawFollowerCount !== undefined && Number.isFinite(Number(rawFollowerCount))
    ? Number(rawFollowerCount) : null;
  const recentEvents = makeRumbleEvents(data);
  const streams = Array.isArray(data.livestreams) ? data.livestreams : [];
  const active = streams.filter(stream => stream && stream.is_live === true);
  if (!active.length) {
    return { ...offline(), followerCount, recentEvents: [] };
  }
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
  return {
    ...live(hasCount ? total : null, title,
      hasCount ? "" : "Rumble reports a live stream, but did not return a public Watching Now count."),
    followerCount,
    recentEvents
  };
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
    const path = url.pathname;

    if (origin && !ALLOWED_ORIGINS.has(origin) && path !== "/api/twitch/eventsub" && path !== "/api/kick/eventsub") {
      return jsonResponse({ error: "Origin not allowed." }, 403);
    }

    if (path === "/api/twitch/eventsub" && request.method === "POST") {
      return handleTwitchEventSub(request, env);
    }
    if (path === "/api/kick/eventsub" && request.method === "POST") {
      return handleKickEventSub(request, env);
    }
    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          "Access-Control-Allow-Origin": origin || "https://bitcoin-cats.ca",
          "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
          "Access-Control-Allow-Headers": "Accept, Content-Type",
          "Access-Control-Max-Age": "86400",
          "Vary": "Origin"
        }
      });
    }
    if (request.method === "GET" && path === "/api/twitch/auth") {
      return beginTwitchAuthorization(env);
    }
    if (request.method === "GET" && path === "/api/twitch/callback") {
      try { return await completeTwitchAuthorization(request, env); }
      catch (error) {
        console.error("Twitch OAuth callback failed", String(error?.message || ""));
        return htmlResponse("Twitch connection failed", "The server could not complete Twitch authorization. Check that the Twitch Client ID, Client Secret and redirect URL are configured correctly, then try again.", 502);
      }
    }
    if (request.method === "GET" && path === "/api/kick/chat") {
      try {
        const result = await getKickChatMessages(env);
        return addCors(jsonResponse({ ok: true, ...result }), origin);
      } catch (error) {
        return addCors(jsonResponse({ ok: false, status: "error", messages: [], note: String(error?.message || "Kick chat is temporarily unavailable.") }), origin);
      }
    }
    if (request.method === "GET" && path === "/api/twitch/followers") {
      try {
        const result = await safelyGet(getTwitchFollowerCount, env);
        return addCors(jsonResponse({
          ok: result.status !== "error",
          followerStatus: result.status,
          followerCount: result.followerCount ?? null,
          followerNote: result.note || ""
        }), origin);
      } catch (error) {
        return addCors(jsonResponse({
          ok: false,
          followerStatus: "error",
          followerCount: null,
          followerNote: String(error?.message || "Twitch follower count is temporarily unavailable.")
        }), origin);
      }
    }
    if (request.method === "GET" && path === "/api/twitch/chat") {
      try {
        const result = await getTwitchChatMessages(env);
        return addCors(jsonResponse({ ok: true, ...result }), origin);
      } catch (error) {
        return addCors(jsonResponse({ ok: false, status: "error", messages: [], note: String(error?.message || "Twitch chat is temporarily unavailable.") }), origin);
      }
    }
    if (request.method !== "GET") {
      return jsonResponse({ error: "Method not allowed." }, 405, { Allow: "GET, POST, OPTIONS" });
    }
    if (path !== "/api/platform-viewers" && path !== "/api/platform-viewers/") {
      return jsonResponse({ error: "Not found." }, 404);
    }

    const cacheKey = new Request(url.origin + "/__internal/platform-viewers-v2", { method: "GET" });
    try {
      const cached = await caches.default.match(cacheKey);
      if (cached) return addCors(cached, origin);
    } catch {
      // Cache is an optimization; provider lookups still work if cache is unavailable.
    }

    const [twitchResult, youtubeResult, kickResult, rumbleResult, twitchFollowers, youtubeFollowers] = await Promise.all([
      safelyGet(getTwitchViewerCount, env),
      safelyGet(getYoutubeViewerCount, env),
      safelyGet(getKickViewerCount, env),
      safelyGet(getRumbleViewerCount, env),
      safelyGet(getTwitchFollowerCount, env),
      safelyGet(getYoutubeFollowerCount, env)
    ]);

    const twitchEvents = env.TWITCH_AUTH
      ? (await env.TWITCH_AUTH.get(TWITCH_CHAT_KEY, "json").catch(() => null) || [])
      : [];
    const platforms = {
      twitch: {
        ...twitchResult,
        followerCount: twitchFollowers.followerCount ?? null,
        followerStatus: twitchFollowers.status,
        followerNote: twitchFollowers.note || "",
        recentEvents: twitchEvents.slice(-50)
      },
      youtube: {
        ...youtubeResult,
        followerCount: youtubeFollowers.followerCount ?? null,
        followerStatus: youtubeFollowers.status,
        followerNote: youtubeFollowers.note || "",
        recentEvents: youtubeResult.recentEvents || []
      },
      kick: {
        ...kickResult,
        followerCount: null,
        followerStatus: "unsupported",
        followerNote: "Kick's documented public channel response does not provide an overall follower total."
      },
      rumble: {
        ...rumbleResult,
        followerCount: rumbleResult.followerCount ?? null,
        followerStatus: rumbleResult.status === "setup_required"
          ? "setup_required"
          : (rumbleResult.followerCount == null ? "unavailable" : "available"),
        followerNote: rumbleResult.status === "setup_required"
          ? "Add the private Rumble Live Stream API URL as a Worker secret."
          : (rumbleResult.followerCount == null ? "Rumble did not return a follower total." : ""),
        recentEvents: rumbleResult.recentEvents || []
      }
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
      "Cache-Control": "public, max-age=10, s-maxage=" + CACHE_SECONDS
    });
    try {
      ctx.waitUntil(caches.default.put(cacheKey, response.clone()));
    } catch {
      // Do not fail a successful provider lookup if caching is unavailable.
    }
    return addCors(response, origin);
  }
};
