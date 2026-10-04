// Keeps the prompt files and the live Make scenario copies in make/ identical. Run: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const read = (p) => fs.readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
const json = (p) => JSON.parse(read(p));
const flat = (flow) => flow.flatMap((m) => [m, ...(m.routes ?? []).flatMap((r) => flat(r.flow))]);

test("daily scenario uses prompts/facebook_post.system.md with the verified facts", () => {
  const facts = json("prompts/verified_facts.json").facts;
  const lines = facts.map((f) => `- ${f.fact_bn} (সূত্র: ${f.source_bn})`).join("\n");
  const expected = read("prompts/facebook_post.system.md").trimEnd().replace("{{VERIFIED_FACTS}}", lines);
  const flow = flat(json("make/daily-plan.scenario.json").blueprint.flow);
  assert.equal(flow.find((m) => m.id === 2).mapper.messages[0].content, expected);
});

test("weekly carousel uses prompts/carousel.system.md and posts only when all 6 slides pass", () => {
  const { scheduling, blueprint } = json("make/weekly-carousel.scenario.json");
  const flow = flat(blueprint.flow);
  assert.equal(flow.find((m) => m.id === 1).mapper.messages[0].content, read("prompts/carousel.system.md").trimEnd());
  const post = flow.find((m) => m.module === "facebook-pages:CreatePostWithPhotos");
  assert.deepEqual(post.filter.conditions[0].map((c) => c.b), ["FAILED", "6"]);
  assert.deepEqual(scheduling, { type: "weekly", days: [5], time: "19:00" });
});

test("image size is fixed at 1024x1280 (4:5) in every image module", () => {
  for (const file of ["make/daily-plan.scenario.json", "make/weekly-carousel.scenario.json"]) {
    const images = flat(json(file).blueprint.flow).filter((m) => m.module === "openai-gpt-3:GenerateImage");
    assert.ok(images.length > 0);
    for (const m of images) assert.equal(m.mapper.size, "1024x1280", `${file} module ${m.id}`);
  }
});

test("every image is drawn from the post's own prompt with its text block, never a textless fallback", () => {
  for (const file of ["make/daily-plan.scenario.json", "make/weekly-carousel.scenario.json"]) {
    const images = flat(json(file).blueprint.flow).filter((m) => m.module === "openai-gpt-3:GenerateImage");
    for (const m of images) assert.match(m.mapper.prompt, /^\{\{\d+\.image_prompt\}\}$/, `${file} module ${m.id}`);
  }
  for (const p of ["prompts/facebook_post.system.md", "prompts/carousel.system.md"]) assert.match(read(p), /TEXT TO INCLUDE IN IMAGE:/);
});
