import { ImageError } from "./errors.js";

/**
 * Image workflow (state machine). A post can only move along the arrows below, so an image can never
 * reach Make.com without passing IMAGE_APPROVED.
 *
 *   CONTENT_APPROVED → IMAGE_BRIEF_GENERATED → IMAGE_PROMPT_GENERATED → IMAGE_GENERATED
 *     → TEXT_OVERLAY_APPLIED → IMAGE_REVIEW_PENDING → IMAGE_APPROVED → READY_TO_SCHEDULE
 *     → SENT_TO_MAKE → PUBLISHED
 *
 *   Side states: BLOCKED (needs information / unsafe content), FAILED (technical error), IMAGE_REJECTED.
 *
 * In the existing content system (Google Sheet `status` column) these map to: CONTENT_APPROVED = "ready" content,
 * IMAGE_REVIEW_PENDING = "needs_review", READY_TO_SCHEDULE = "ready", PUBLISHED = "published".
 */
export const STATES = [
  "CONTENT_APPROVED",
  "IMAGE_BRIEF_GENERATED",
  "IMAGE_PROMPT_GENERATED",
  "IMAGE_GENERATED",
  "TEXT_OVERLAY_APPLIED",
  "IMAGE_REVIEW_PENDING",
  "IMAGE_APPROVED",
  "READY_TO_SCHEDULE",
  "SENT_TO_MAKE",
  "PUBLISHED",
  "BLOCKED",
  "FAILED",
  "IMAGE_REJECTED",
];

const NEXT = {
  CONTENT_APPROVED: ["IMAGE_BRIEF_GENERATED", "BLOCKED"],
  IMAGE_BRIEF_GENERATED: ["IMAGE_PROMPT_GENERATED", "BLOCKED", "FAILED"],
  IMAGE_PROMPT_GENERATED: ["IMAGE_GENERATED", "TEXT_OVERLAY_APPLIED", "FAILED", "BLOCKED"],
  IMAGE_GENERATED: ["TEXT_OVERLAY_APPLIED", "FAILED"],
  TEXT_OVERLAY_APPLIED: ["IMAGE_REVIEW_PENDING", "FAILED"],
  // From review a person can approve, reject, or ask for changes (which restarts at the right step).
  IMAGE_REVIEW_PENDING: ["IMAGE_APPROVED", "IMAGE_REJECTED", "IMAGE_BRIEF_GENERATED", "IMAGE_PROMPT_GENERATED", "TEXT_OVERLAY_APPLIED", "IMAGE_REVIEW_PENDING"],
  IMAGE_APPROVED: ["READY_TO_SCHEDULE"],
  READY_TO_SCHEDULE: ["SENT_TO_MAKE", "IMAGE_REVIEW_PENDING"],
  SENT_TO_MAKE: ["PUBLISHED", "READY_TO_SCHEDULE"],
  PUBLISHED: [],
  BLOCKED: ["IMAGE_BRIEF_GENERATED"],
  FAILED: ["IMAGE_BRIEF_GENERATED", "IMAGE_PROMPT_GENERATED", "TEXT_OVERLAY_APPLIED", "IMAGE_REVIEW_PENDING"],
  IMAGE_REJECTED: ["IMAGE_BRIEF_GENERATED"],
};

export function canTransition(from, to) {
  return (NEXT[from] ?? []).includes(to);
}

/** Move meta to a new state, recording who/why in meta.history. Throws on an illegal move. */
export function transition(meta, to, note = "") {
  const from = meta.status;
  if (!STATES.includes(to)) throw new ImageError("INVALID_STATE", `Unknown state ${to}`);
  if (from && !canTransition(from, to)) throw new ImageError("INVALID_TRANSITION", `Cannot go from ${from} to ${to}${NEXT[from]?.length ? ` (allowed: ${NEXT[from].join(", ")})` : ""}`);
  meta.status = to;
  meta.history ??= [];
  meta.history.push({ at: new Date().toISOString(), from: from ?? null, to, ...(note && { note }) });
  return meta;
}

/** Walk several steps at once (each must be legal). */
export function advance(meta, states, note) {
  for (const s of states) transition(meta, s, note);
  return meta;
}
