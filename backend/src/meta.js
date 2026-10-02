import { config, requireConfig } from "./config.js";
import { withRetry } from "./retry.js";

async function graph(path, params) {
  requireConfig(["META_PAGE_ACCESS_TOKEN", config.meta.pageToken]);
  const url = new URL(`https://graph.facebook.com/${config.meta.graphVersion}/${path}`);
  for (const [k, v] of Object.entries({ ...params, access_token: config.meta.pageToken })) url.searchParams.set(k, v);
  return withRetry(
    async () => {
      const res = await fetch(url);
      const body = await res.json().catch(() => ({}));
      if (!res.ok || body.error) {
        const code = body.error?.code;
        // 4/17/32/613 = rate limits → retryable; 190 (token) / 10, 200 (permissions) / 100 (bad param) are not.
        const status = [4, 17, 32, 613].includes(code) ? 429 : res.status >= 500 ? res.status : 400;
        throw Object.assign(new Error(`Graph ${path}: ${body.error?.message ?? res.statusText} (code ${code})`), { status, code });
      }
      return body;
    },
    { label: `graph ${path.split("/")[0]}` },
  );
}

const metric = (data, name) => data.find((d) => d.name === name)?.values?.[0]?.value ?? 0;

/** Instagram media insights → { likes, comments, shares, saves, reach }. */
export async function instagramMetrics(mediaId) {
  const { data = [] } = await graph(`${mediaId}/insights`, { metric: "likes,comments,shares,saved,reach" });
  return { media_id: mediaId, likes: metric(data, "likes"), comments: metric(data, "comments"), shares: metric(data, "shares"), saves: metric(data, "saved"), reach: metric(data, "reach") };
}

/** Facebook Page post stats (saves are not exposed by Facebook). */
export async function facebookMetrics(postId) {
  const body = await graph(postId, { fields: "shares,reactions.summary(total_count).limit(0),comments.summary(total_count).limit(0)" });
  let reach = 0;
  try {
    const ins = await graph(`${postId}/insights`, { metric: "post_impressions_unique" });
    reach = ins.data?.[0]?.values?.[0]?.value ?? 0;
  } catch {
    // needs read_insights; reach stays 0 for Facebook
  }
  return {
    media_id: postId,
    likes: body.reactions?.summary?.total_count ?? 0,
    comments: body.comments?.summary?.total_count ?? 0,
    shares: body.shares?.count ?? 0,
    saves: 0,
    reach,
  };
}
