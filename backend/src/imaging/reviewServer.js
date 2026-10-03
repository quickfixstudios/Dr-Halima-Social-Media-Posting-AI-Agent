#!/usr/bin/env node
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { imagingConfig } from "../config.js";
import { createImageJob, runAction, listJobs, openStore } from "./pipeline.js";
import { CATEGORIES } from "./categories.js";
import { REASONS } from "./regenerate.js";
import { classifyError } from "./errors.js";

/**
 * Human review screen — run `npm run review` and open http://localhost:8091
 *
 * It only listens on this computer (127.0.0.1) unless REVIEW_HOST is changed, in which case REVIEW_PASSWORD
 * is required. Every form carries a random token so other websites cannot trigger actions (CSRF protection).
 */
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const TOKEN = crypto.randomBytes(16).toString("hex");
const STATUS_COLOR = { IMAGE_REVIEW_PENDING: "#b9770e", READY_TO_SCHEDULE: "#1e8449", SENT_TO_MAKE: "#2a7f79", PUBLISHED: "#2f4858", BLOCKED: "#c0392b", FAILED: "#c0392b", IMAGE_REJECTED: "#7f8c8d" };

const page = (title, body, msg = "") => `<!doctype html><html lang="bn"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title><style>
body{font-family:system-ui,"Hind Siliguri",sans-serif;margin:0;background:#f4f6f7;color:#1e2a32}
header{background:#2f4858;color:#fff;padding:12px 20px}header a{color:#fff;text-decoration:none;font-weight:600}
main{max-width:1200px;margin:0 auto;padding:16px}
.card{background:#fff;border-radius:12px;padding:16px;margin:0 0 16px;box-shadow:0 1px 3px #0001}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:16px}
.badge{display:inline-block;padding:2px 10px;border-radius:99px;color:#fff;font-size:12px;font-weight:600}
img.final{width:100%;max-width:420px;border-radius:8px;border:1px solid #ddd}
.slides{display:flex;gap:8px;overflow-x:auto}.slides img{width:240px}
.row{display:flex;gap:20px;flex-wrap:wrap}.row>*{flex:1 1 320px}pre.caption{font-family:inherit;font-size:14px}
pre{white-space:pre-wrap;background:#f4f6f7;padding:10px;border-radius:8px;font-size:12px;max-height:320px;overflow:auto}
form{margin:8px 0}input[type=text],textarea,select{width:100%;box-sizing:border-box;padding:8px;border:1px solid #ccd;border-radius:6px;font:inherit}
button{padding:8px 14px;border:0;border-radius:6px;background:#2a7f79;color:#fff;font-weight:600;cursor:pointer;margin-top:6px}
button.danger{background:#c0392b}button.grey{background:#7f8c8d}
.msg{padding:10px 14px;border-radius:8px;background:#e6f4ec;margin-bottom:16px}.err{background:#fbeaea}
table{border-collapse:collapse;width:100%}td,th{padding:6px;border-bottom:1px solid #eee;text-align:left;font-size:14px;vertical-align:top}
.ok{color:#1e8449}.bad{color:#c0392b}small{color:#5b6770}
</style></head><body><header><a href="/">Image review</a></header><main>${msg ? `<div class="msg ${msg.startsWith("Error") ? "err" : ""}">${esc(msg)}</div>` : ""}${body}</main></body></html>`;

const badge = (s) => `<span class="badge" style="background:${STATUS_COLOR[s] ?? "#5b6770"}">${esc(s)}</span>`;
const hidden = (name, value) => `<input type="hidden" name="${name}" value="${esc(value)}">`;
const actionForm = (postId, action, inner, label, cls = "") => `<form method="post" action="/post/${encodeURIComponent(postId)}/action">${hidden("token", TOKEN)}${hidden("action", action)}${inner}<button class="${cls}">${esc(label)}</button></form>`;

function listPage(business, msg) {
  const jobs = listJobs({ businessId: business });
  const rows = jobs
    .map((m) => {
      const c = m.candidates.find((x) => x.id === m.selected) ?? m.candidates.at(-1);
      const file = c?.finals.at(-1)?.files[0];
      return `<div class="card"><a href="/post/${encodeURIComponent(m.post_id)}">${file ? `<img class="final" src="/file/${encodeURIComponent(m.post_id)}/${file}">` : "<p><i>no image</i></p>"}</a>
      <p>${badge(m.status)}</p><p><b>${esc(m.post_id)}</b><br>${esc(m.content?.topic)}</p><a href="/post/${encodeURIComponent(m.post_id)}">Open →</a></div>`;
    })
    .join("");
  const { cfg } = openStore(business);
  const samples = fs.existsSync(path.join(cfg.postsDir, business, "samples")) ? fs.readdirSync(path.join(cfg.postsDir, business, "samples")).filter((f) => f.endsWith(".json")) : [];
  const create = `<div class="card"><h3>Create images for a post</h3>
    <form method="post" action="/create">${hidden("token", TOKEN)}
    <label>Post file in posts/${esc(business)}/ <select name="file">${samples.map((f) => `<option value="samples/${esc(f)}">samples/${esc(f)}</option>`).join("")}</select></label>
    <label>Concepts (creative directions) <select name="concepts"><option>1</option><option>2</option><option>3</option><option>4</option></select></label>
    <label><input type="checkbox" name="dry_run" value="1" checked> Dry run (free preview, no OpenAI call)</label>
    <button>Create</button></form><small>Real runs cost one image generation per concept.</small></div>`;
  return page("Image review", `${create}<h2>Posts (${jobs.length})</h2><div class="grid">${rows || "<p>No image jobs yet.</p>"}</div>`, msg);
}

function postPage(business, postId, msg) {
  const { store } = openStore(business);
  const m = store.load(postId);
  const post = m.content;
  const cands = m.candidates
    .map((c) => {
      const f = c.finals.at(-1);
      const imgs = f ? f.files.map((file) => `<img class="final" src="/file/${encodeURIComponent(postId)}/${file}">`).join("") : `<p><i>${esc(c.error?.message ?? "no image")}</i></p>`;
      const ck = f?.checklist;
      const checks = ck
        ? Object.entries(ck)
            .filter(([, v]) => typeof v === "boolean")
            .map(([k, v]) => `<span class="${v ? "ok" : "bad"}">${v ? "✔" : "✘"} ${esc(k)}</span>`)
            .join(" · ")
        : "";
      const issues = (f?.overlay_issues ?? []).map((i) => `<li class="${i.blocking ? "bad" : ""}">${esc(i.rule)}: “${esc(i.match)}” — ${esc(i.note ?? "")}</li>`).join("");
      const gens = c.generations.map((g) => `${esc(g.id)} ${esc(g.kind)} ${esc(g.model ?? "")} ${esc(g.size ?? "")} ${g.cost_usd != null ? `$${g.cost_usd}` : "cost unknown"} ${g.request_id ? `<small>req ${esc(g.request_id)}</small>` : ""}`).join("<br>");
      return `<div class="card"><h3>${c.id === m.selected ? "▶ " : ""}${esc(c.id)} — ${esc(c.brief.visual_type_label)}${c.concept_mode ? ` (${esc(c.concept_mode)})` : ""} <small>fit ${esc(c.fit_score)}</small></h3>
      <div class="${f && f.files.length > 1 ? "slides" : ""}">${imgs}</div>
      <p>${checks}</p>${ck?.notes?.length ? `<p><small>${esc(ck.notes.join(" "))}</small></p>` : ""}
      ${issues ? `<ul>${issues}</ul>` : ""}
      ${c.brief.flags.length ? `<p><small>${c.brief.flags.map((x) => esc(x.message)).join("<br>")}</small></p>` : ""}
      <table><tr><th>Headline</th><td>${esc(c.brief.text.headline)}</td></tr><tr><th>CTA</th><td>${esc(c.brief.text.cta || "—")}</td></tr><tr><th>Layout</th><td>${esc(c.brief.layout)} · ${esc(c.brief.aspect_ratio)}</td></tr><tr><th>Generations</th><td>${gens || "—"}</td></tr></table>
      <details><summary>Image prompt (v${c.prompts.at(-1).version})</summary><pre>${esc(c.prompts.at(-1).text)}</pre></details>
      <details><summary>Creative brief</summary><pre>${esc(JSON.stringify(c.brief, null, 2))}</pre></details>
      ${m.status === "IMAGE_REVIEW_PENDING" && c.id !== m.selected && f ? actionForm(postId, "select", hidden("candidate", c.id), "Choose this concept", "grey") : ""}
      </div>`;
    })
    .join("");
  const sel = m.candidates.find((c) => c.id === m.selected);
  const review =
    m.status === "IMAGE_REVIEW_PENDING"
      ? `<div class="card"><h3>Review actions (concept ${esc(m.selected)})</h3><div class="row"><div>${(sel?.finals.at(-1)?.files ?? []).slice(0, 1).map((file) => `<img class="final" src="/file/${encodeURIComponent(postId)}/${file}">`).join("")}</div><div>
      ${actionForm(postId, "approve", `<input type="text" name="by" placeholder="Your name">`, "APPROVE")}
      ${actionForm(postId, "regenerate", `<select name="reason">${Object.entries(REASONS).map(([k, r]) => `<option value="${k}">${esc(r.label)} — ${r.scope === "overlay" ? "text only, free" : "new picture"}</option>`).join("")}</select><input type="text" name="headline" placeholder="New headline (only for 'Keep image, change text')"><input type="text" name="note" placeholder="Optional note">`, "REGENERATE")}
      ${actionForm(postId, "edit_headline", `<input type="text" name="headline" value="${esc(sel?.brief.text.headline)}">`, "EDIT HEADLINE (free)")}
      ${actionForm(postId, "edit_prompt", `<textarea name="prompt" rows="5" placeholder="Describe the picture you want. Safety rules are added automatically.">${esc(sel?.prompt_override ?? "")}</textarea>`, "EDIT PROMPT (new picture)")}
      ${actionForm(postId, "change_type", `<select name="visual_type">${CATEGORIES.map((c) => `<option value="${c.id}" ${c.id === sel?.visual_type ? "selected" : ""}>${esc(c.label)}</option>`).join("")}</select>`, "CHANGE IMAGE TYPE (new picture)")}
      ${actionForm(postId, "reject", `<input type="text" name="note" placeholder="Why?">`, "REJECT", "danger")}</div></div></div>`
      : m.status === "READY_TO_SCHEDULE"
        ? `<div class="card"><h3>Approved by ${esc(m.approval?.by)} — ready for Make.com</h3>${actionForm(postId, "send", "", "SEND TO MAKE.COM")}${actionForm(postId, "unapprove", "", "Withdraw approval", "grey")}</div>`
        : m.status === "SENT_TO_MAKE"
          ? `<div class="card"><h3>Sent to Make.com</h3><p>${esc(JSON.stringify(m.make?.response ?? {}))}</p>${actionForm(postId, "published", `<input type="text" name="fb_post_id" placeholder="Facebook post id (optional)">`, "Mark as published")}</div>`
          : "";
  const body = `<div class="card"><h2>${esc(postId)} ${badge(m.status)}</h2>
    ${m.blocked?.length ? `<p class="bad"><b>Blocked:</b><br>${m.blocked.map((b) => esc(b.message)).join("<br>")}</p>` : ""}
    <table><tr><th>Topic</th><td>${esc(post.topic)}</td></tr><tr><th>Hook</th><td>${esc(post.hook)}</td></tr><tr><th>Caption</th><td><pre class="caption">${esc(post.caption)}</pre></td></tr>
    <tr><th>Cost</th><td>${m.cost ? `$${m.cost.total_usd}${m.cost.unknown ? ` + ${m.cost.unknown} image(s) with unknown price` : ""}` : "—"}</td></tr></table></div>
    ${review}${cands}
    <div class="card"><details><summary>History</summary><pre>${esc(m.history.map((h) => `${h.at}  ${h.from ?? "—"} → ${h.to}${h.note ? `  (${h.note})` : ""}`).join("\n"))}</pre></details></div>`;
  return page(postId, body, msg);
}

async function readForm(req) {
  let body = "";
  for await (const chunk of req) {
    body += chunk;
    if (body.length > 200_000) throw new Error("Form too large");
  }
  return Object.fromEntries(new URLSearchParams(body));
}

export function createReviewServer({ business = imagingConfig().defaultBusiness, password = imagingConfig().review.password } = {}) {
  return http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://localhost");
    const send = (status, html, type = "text/html; charset=utf-8") => {
      res.writeHead(status, { "Content-Type": type, "X-Frame-Options": "DENY", "Cache-Control": "no-store" });
      res.end(html);
    };
    const redirect = (to, msg) => {
      res.writeHead(303, { Location: `${to}${msg ? `${to.includes("?") ? "&" : "?"}msg=${encodeURIComponent(msg)}` : ""}` });
      res.end();
    };
    try {
      if (password) {
        const given = Buffer.from((req.headers.authorization ?? "").replace(/^Basic\s+/i, ""), "base64").toString().split(":").slice(1).join(":");
        if (given.length !== password.length || !crypto.timingSafeEqual(Buffer.from(given), Buffer.from(password))) {
          res.writeHead(401, { "WWW-Authenticate": 'Basic realm="image review"' });
          return res.end("Password required");
        }
      }
      const msg = url.searchParams.get("msg") ?? "";
      if (req.method === "GET" && url.pathname === "/") return send(200, listPage(business, msg));
      let m = url.pathname.match(/^\/post\/([^/]+)$/);
      if (req.method === "GET" && m) return send(200, postPage(business, decodeURIComponent(m[1]), msg));
      m = url.pathname.match(/^\/file\/([^/]+)\/(.+)$/);
      if (req.method === "GET" && m) {
        const { store } = openStore(business);
        const abs = store.absolute(decodeURIComponent(m[1]), decodeURIComponent(m[2]));
        return send(200, fs.readFileSync(abs), abs.endsWith(".png") ? "image/png" : "image/jpeg");
      }
      m = url.pathname.match(/^\/dryrun\/([^/]+)\/([^/]+\.jpg)$/);
      if (req.method === "GET" && m) {
        const { brand, cfg } = openStore(business);
        const abs = path.join(cfg.assetsDir, "_dryrun", brand.asset_folder, path.basename(decodeURIComponent(m[1])), path.basename(m[2]));
        return fs.existsSync(abs) ? send(200, fs.readFileSync(abs), "image/jpeg") : send(404, "not found", "text/plain");
      }
      if (req.method === "POST") {
        const form = await readForm(req);
        if (form.token !== TOKEN) return send(403, page("Forbidden", "<p>Form expired — reload the page and try again.</p>"));
        if (url.pathname === "/create") {
          const { cfg } = openStore(business);
          const file = path.resolve(cfg.postsDir, business, form.file ?? "");
          if (!file.startsWith(path.join(cfg.postsDir, business) + path.sep) || !fs.existsSync(file)) return redirect("/", "Error: post file not found");
          try {
            const r = await createImageJob({ businessId: business, post: JSON.parse(fs.readFileSync(file, "utf8")), options: { dryRun: form.dry_run === "1", concepts: Number(form.concepts || 1) } });
            if (r.dry_run) {
              const imgs = r.concepts.flatMap((c) => c.preview_files.map((f) => `<img class="final" src="/dryrun/${encodeURIComponent(r.post_id)}/${encodeURIComponent(path.basename(f))}">`)).join("");
              const details = r.concepts.map((c) => `<div class="card"><h3>${esc(c.label)}</h3><p>${c.halts.map((h) => `<span class="bad">${esc(h.message)}</span>`).join("<br>")}</p><pre>${esc(c.overlay_text.join("\n"))}</pre><details><summary>Prompt</summary><pre>${esc(c.prompt)}</pre></details></div>`).join("");
              return send(200, page("Dry run", `<div class="card"><h2>Dry run — ${esc(r.post_id)}</h2><p>No OpenAI credits used. Would generate ${r.estimated_generations} image(s).</p><div class="slides">${imgs}</div></div>${details}<a href="/">← back</a>`));
            }
            return redirect(`/post/${encodeURIComponent(r.post_id)}`, `Created: ${r.status}`);
          } catch (err) {
            return redirect("/", `Error: ${classifyError(err).message}`);
          }
        }
        m = url.pathname.match(/^\/post\/([^/]+)\/action$/);
        if (m) {
          const postId = decodeURIComponent(m[1]);
          try {
            await runAction({ businessId: business, postId, action: form.action, params: { ...form, token: undefined } });
            return redirect(`/post/${encodeURIComponent(postId)}`, `Done: ${form.action}`);
          } catch (err) {
            return redirect(`/post/${encodeURIComponent(postId)}`, `Error: ${classifyError(err).message}`);
          }
        }
      }
      send(404, page("Not found", "<p>Not found</p>"));
    } catch (err) {
      send(500, page("Error", `<p class="bad">${esc(classifyError(err).message)}</p><a href="/">← back</a>`));
    }
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { host, port, password } = imagingConfig().review;
  const loopback = ["127.0.0.1", "localhost", "::1"].includes(host);
  if (!loopback && !password) {
    console.error("[IMAGE ERROR] REVIEW_HOST is not this computer, so REVIEW_PASSWORD must be set.");
    process.exit(1);
  }
  createReviewServer().listen(port, host, () => console.log(`[IMAGE] Review screen: http://${host === "127.0.0.1" ? "localhost" : host}:${port}  (Ctrl+C to stop)`));
}
