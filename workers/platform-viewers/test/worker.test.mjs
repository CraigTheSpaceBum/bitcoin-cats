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
  }
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
