import test from "node:test";
import assert from "node:assert/strict";
import worker from "../src/index.js";
import { createHmac, webcrypto } from "node:crypto";

if (!globalThis.crypto) globalThis.crypto = webcrypto;

globalThis.caches = {
  default: {
    async match() { return null; },
    async put() {}
  }
};

function context() {
  return { waitUntil() {} };
}

test("GET returns setup-required platform states when provider secrets are not configured", async () => {
  const request = new Request("https://bitcoin-cats.ca/api/platform-viewers", {
    method: "GET",
    headers: { Origin: "https://bitcoin-cats.ca" }
  });
  const response = await worker.fetch(request, {}, context());
  const payload = await response.json();

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("Access-Control-Allow-Origin"), "https://bitcoin-cats.ca");
  assert.deepEqual(
    Object.keys(payload.platforms).sort(),
    ["kick", "rumble", "twitch", "youtube"]
  );
  for (const platform of Object.values(payload.platforms)) {
    assert.equal(platform.status, "setup_required");
    assert.equal(platform.viewerCount, null);
    assert.ok(["setup_required", "unsupported"].includes(platform.followerStatus) ||
      platform.followerStatus === "unavailable");
  }
  assert.equal(payload.platforms.twitch.followerStatus, "setup_required");
  assert.equal(payload.platforms.youtube.followerStatus, "setup_required");
  assert.equal(payload.platforms.kick.followerStatus, "unsupported");
  assert.equal(payload.platforms.rumble.followerStatus, "setup_required");
  assert.equal(payload.totalViewers, null);
});

test("POST requests are rejected", async () => {
  const response = await worker.fetch(
    new Request("https://bitcoin-cats.ca/api/platform-viewers", { method: "POST" }),
    {},
    context()
  );
  assert.equal(response.status, 405);
});

test("requests from unrelated origins are rejected", async () => {
  const response = await worker.fetch(
    new Request("https://bitcoin-cats.ca/api/platform-viewers", {
      headers: { Origin: "https://example.org" }
    }),
    {},
    context()
  );
  assert.equal(response.status, 403);
});

test("unknown paths are rejected", async () => {
  const response = await worker.fetch(
    new Request("https://bitcoin-cats.ca/api/other"),
    {},
    context()
  );
  assert.equal(response.status, 404);
});

test("Twitch follower endpoint returns setup required until broadcaster OAuth is connected", async () => {
  const response = await worker.fetch(
    new Request("https://api.bitcoin-cats.ca/api/twitch/followers", {
      headers: { Origin: "https://bitcoin-cats.ca" }
    }),
    {},
    context()
  );
  const payload = await response.json();
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("Access-Control-Allow-Origin"), "https://bitcoin-cats.ca");
  assert.equal(payload.followerStatus, "setup_required");
  assert.equal(payload.followerCount, null);
});

test("Twitch chat reports setup required until broadcaster OAuth is connected", async () => {
  const response = await worker.fetch(
    new Request("https://bitcoin-cats.ca/api/twitch/chat", {
      headers: { Origin: "https://bitcoin-cats.ca" }
    }),
    {},
    context()
  );
  const payload = await response.json();
  assert.equal(response.status, 200);
  assert.equal(payload.status, "setup_required");
  assert.deepEqual(payload.messages, []);
});

test("Twitch authorization explains when Worker credentials are missing", async () => {
  const response = await worker.fetch(
    new Request("https://bitcoin-cats.ca/api/twitch/auth"),
    {},
    context()
  );
  assert.equal(response.status, 503);
  assert.match(await response.text(), /credentials/i);
});

test("Twitch EventSub rejects unsigned webhook requests", async () => {
  const response = await worker.fetch(
    new Request("https://bitcoin-cats.ca/api/twitch/eventsub", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Twitch-Eventsub-Message-Type": "notification" },
      body: JSON.stringify({ subscription: { type: "channel.chat.message" }, event: {} })
    }),
    {},
    context()
  );
  assert.equal(response.status, 403);
});


test("Kick chat reports setup required until its app webhook is configured", async () => {
  const response = await worker.fetch(
    new Request("https://api.bitcoin-cats.ca/api/kick/chat", {
      headers: { Origin: "https://bitcoin-cats.ca" }
    }),
    {},
    context()
  );
  const payload = await response.json();
  assert.equal(response.status, 200);
  assert.equal(payload.status, "setup_required");
  assert.deepEqual(payload.messages, []);
});

test("Kick EventSub rejects unsigned webhook requests", async () => {
  const response = await worker.fetch(
    new Request("https://api.bitcoin-cats.ca/api/kick/eventsub", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Kick-Event-Type": "chat.message.sent" },
      body: JSON.stringify({ content: "not verified" })
    }),
    {},
    context()
  );
  assert.equal(response.status, 403);
});


class MemoryKV {
  constructor(initial = {}) {
    this.values = new Map(Object.entries(initial));
  }
  async get(key, type) {
    const value = this.values.get(key);
    if (value === undefined) return null;
    if (type === "json" && typeof value === "string") return JSON.parse(value);
    return value;
  }
  async put(key, value) {
    this.values.set(key, String(value));
  }
  async delete(key) {
    this.values.delete(key);
  }
}

test("Twitch chat endpoint repairs missing chat and follow EventSub subscriptions", async () => {
  const kv = new MemoryKV({
    "twitch:auth": JSON.stringify({
      accessToken: "test-access-token",
      refreshToken: "test-refresh-token",
      expiresAt: Date.now() + 3600000,
      userId: "12345",
      login: "craigthespacebum",
      scopes: ["user:read:chat", "moderator:read:followers"]
    }),
    "twitch:eventsub:secret": "eventsub-test-secret"
  });
  const originalFetch = globalThis.fetch;
  const posted = [];
  globalThis.fetch = async (url, init = {}) => {
    const target = new URL(url);
    if (target.pathname.endsWith("/eventsub/subscriptions") && (init.method || "GET") === "GET") {
      return new Response(JSON.stringify({ data: [] }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    if (target.pathname.endsWith("/eventsub/subscriptions") && init.method === "POST") {
      const body = JSON.parse(init.body);
      posted.push(body);
      return new Response(JSON.stringify({ data: [{ status: "webhook_callback_verification_pending" }] }), {
        status: 202,
        headers: { "Content-Type": "application/json" }
      });
    }
    throw new Error("Unexpected Twitch API request: " + target.toString());
  };
  try {
    const response = await worker.fetch(
      new Request("https://api.bitcoin-cats.ca/api/twitch/chat", { headers: { Origin: "https://bitcoin-cats.ca" } }),
      { TWITCH_AUTH: kv, TWITCH_CLIENT_ID: "test-client-id", TWITCH_CLIENT_SECRET: "test-client-secret" },
      context()
    );
    const payload = await response.json();
    assert.equal(response.status, 200);
    assert.equal(payload.status, "connected");
    assert.equal(payload.eventSubStatus, "active");
    assert.equal(posted.length, 3);
    const follows = posted.find(item => item.type === "channel.follow");
    assert.equal(follows.version, "2");
    assert.deepEqual(follows.condition, { broadcaster_user_id: "12345", moderator_user_id: "12345" });
    const chat = posted.find(item => item.type === "channel.chat.message");
    assert.deepEqual(chat.condition, { broadcaster_user_id: "12345", user_id: "12345" });
    const saved = JSON.parse(await kv.get("twitch:connection-status"));
    assert.equal(saved.subscriptions.length, 3);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Twitch EventSub diagnostics preserve the provider's safe error message", async () => {
  const kv = new MemoryKV({
    "twitch:auth": JSON.stringify({
      accessToken: "test-access-token",
      refreshToken: "test-refresh-token",
      expiresAt: Date.now() + 3600000,
      userId: "12345",
      login: "craigthespacebum",
      scopes: ["user:read:chat", "moderator:read:followers"]
    }),
    "twitch:eventsub:secret": "eventsub-test-secret"
  });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const target = new URL(url);
    if ((init.method || "GET") === "GET") {
      return new Response(JSON.stringify({ data: [] }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    return new Response(JSON.stringify({ message: "Test callback validation error." }), {
      status: 400,
      headers: { "Content-Type": "application/json" }
    });
  };
  try {
    const response = await worker.fetch(
      new Request("https://api.bitcoin-cats.ca/api/twitch/chat", { headers: { Origin: "https://bitcoin-cats.ca" } }),
      { TWITCH_AUTH: kv, TWITCH_CLIENT_ID: "test-client-id", TWITCH_CLIENT_SECRET: "test-client-secret" },
      context()
    );
    const payload = await response.json();
    assert.equal(payload.eventSubStatus, "error");
    assert.match(payload.subscriptions[0].note, /Test callback validation error/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Twitch channel.follow webhook is stored as a chat notification", async () => {
  const secret = "eventsub-test-secret";
  const kv = new MemoryKV({ "twitch:eventsub:secret": secret });
  const body = JSON.stringify({
    subscription: { type: "channel.follow", version: "2" },
    event: {
      user_name: "NewFollower",
      user_login: "newfollower",
      followed_at: "2026-11-25T22:00:00Z"
    }
  });
  const messageId = "follow-event-test";
  const timestamp = new Date().toISOString();
  const signature = "sha256=" + createHmac("sha256", secret).update(messageId + timestamp + body).digest("hex");
  const response = await worker.fetch(
    new Request("https://api.bitcoin-cats.ca/api/twitch/eventsub", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Twitch-Eventsub-Message-Type": "notification",
        "Twitch-Eventsub-Message-Id": messageId,
        "Twitch-Eventsub-Message-Timestamp": timestamp,
        "Twitch-Eventsub-Message-Signature": signature
      },
      body
    }),
    { TWITCH_AUTH: kv },
    context()
  );
  assert.equal(response.status, 204);
  const events = JSON.parse(await kv.get("twitch:chat:events"));
  assert.equal(events.length, 1);
  assert.equal(events[0].source, "Twitch");
  assert.equal(events[0].displayName, "NewFollower");
  assert.equal(events[0].badge, "NEW FOLLOWER");
  assert.equal(events[0].message, "Followed the channel");
});
