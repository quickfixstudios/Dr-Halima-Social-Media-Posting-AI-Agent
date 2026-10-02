import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "../src/server.js";

let server;
let base;
before(async () => {
  server = createServer({ apiKey: "test-key" });
  await new Promise((r) => server.listen(0, r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

const call = (path, { method = "GET", key, body } = {}) =>
  fetch(`${base}${path}`, { method, headers: { ...(key && { Authorization: `Bearer ${key}` }), "Content-Type": "application/json" }, body: body && JSON.stringify(body) });

test("healthz is public", async () => {
  const res = await call("/healthz");
  assert.equal(res.status, 200);
  assert.equal((await res.json()).ok, true);
});

test("API routes require the bearer key", async () => {
  assert.equal((await call("/v1/daily-run", { method: "POST", body: {} })).status, 401);
  assert.equal((await call("/v1/daily-run", { method: "POST", key: "wrong-key", body: {} })).status, 401);
});

test("input validation and unknown routes", async () => {
  assert.equal((await call("/v1/daily-run", { method: "POST", key: "test-key", body: { date: "02/10/2026" } })).status, 400);
  assert.equal((await call("/v1/compliance", { method: "POST", key: "test-key", body: {} })).status, 400);
  assert.equal((await call("/nope")).status, 404);
});
