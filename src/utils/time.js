import { DateTime } from "luxon";

/** Today's date (YYYY-MM-DD) in the brand's timezone. */
export function todayIn(timezone) {
  return DateTime.now().setZone(timezone).toISODate();
}

/**
 * Convert a local date + "HH:mm" slot in `timezone` into a UTC Date.
 * e.g. slotToUtc("2026-10-02", "10:00", "Asia/Dhaka") -> 2026-10-02T04:00:00Z
 */
export function slotToUtc(isoDate, hhmm, timezone) {
  const [hour, minute] = hhmm.split(":").map(Number);
  const dt = DateTime.fromISO(isoDate, { zone: timezone }).set({ hour, minute, second: 0, millisecond: 0 });
  if (!dt.isValid) throw new Error(`Invalid slot ${isoDate} ${hhmm} (${timezone}): ${dt.invalidExplanation}`);
  return dt.toUTC().toJSDate();
}
