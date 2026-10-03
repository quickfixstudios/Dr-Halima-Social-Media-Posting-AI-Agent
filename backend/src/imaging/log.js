/**
 * Human-readable log lines for the image pipeline, e.g.
 *   [IMAGE] Post sample-03 — Selected type: Myth vs Fact
 *   [IMAGE ERROR] Post sample-07 — Missing verified statistic
 * Never pass secrets to these functions. Set IMAGE_LOG=silent to mute (tests do this).
 */
export function createImageLog(postId, { sink } = {}) {
  const silent = process.env.IMAGE_LOG === "silent";
  const out = sink ?? ((line, isError) => (isError ? process.stderr : process.stdout).write(line + "\n"));
  const prefix = postId ? `Post ${postId} — ` : "";
  return {
    step: (msg) => !silent && out(`[IMAGE] ${prefix}${msg}`, false),
    warn: (msg) => !silent && out(`[IMAGE WARNING] ${prefix}${msg}`, true),
    error: (msg) => !silent && out(`[IMAGE ERROR] ${prefix}${msg}`, true),
  };
}
