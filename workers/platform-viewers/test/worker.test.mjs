import test from "node:test";
import assert from "node:assert/strict";
import worker from "../src/index.js";

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
