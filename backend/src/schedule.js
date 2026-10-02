import { DateTime } from "luxon";
import { config } from "./config.js";

export const SLOTS = ["slot1", "slot2", "slot3", "slot4", "slot5"];
export const slotIndex = (slot) => SLOTS.indexOf(slot);

/** Today's date (YYYY-MM-DD) in the brand time zone. */
export function todayLocal(timezone = config.schedule.timezone, now = DateTime.now()) {
  return now.setZone(timezone).toISODate();
}

/**
 * ISO timestamp with explicit offset for a slot, e.g. ("2026-10-02","slot2") → "2026-10-02T13:00:00+06:00".
 * Uses luxon so it stays correct even for a time zone with DST.
 */
export function scheduledAt(date, slot, { slotTimes = config.schedule.slotTimes, timezone = config.schedule.timezone } = {}) {
  const time = slotTimes[slotIndex(slot)];
  if (!time) throw new Error(`No time configured for ${slot}`);
  const [hour, minute] = time.split(":").map(Number);
  const dt = DateTime.fromISO(date, { zone: timezone }).set({ hour, minute, second: 0, millisecond: 0 });
  if (!dt.isValid) throw new Error(`Invalid date ${date}`);
  return dt.toISO({ suppressMilliseconds: true });
}
