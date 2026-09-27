import { redisConnection } from "../queue/redisConnection";
import { env } from "../config/env";

/**
 * Global (per-sender) emails-per-hour limit, enforced with a Redis counter
 * keyed by sender + hour-window. This is safe across multiple worker
 * processes/instances because the increment is atomic in Redis — no
 * in-memory state is used, so horizontally scaling the worker doesn't
 * break the limit.
 */

function hourWindowKey(sender: string, atMs: number): string {
  const d = new Date(atMs);
  const bucket = `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, "0")}${String(
    d.getUTCDate()
  ).padStart(2, "0")}${String(d.getUTCHours()).padStart(2, "0")}`;
  return `rate:${sender}:${bucket}`;
}

/** Start (ms) of the next UTC hour window after `atMs`. */
export function nextHourWindowStart(atMs: number): number {
  const d = new Date(atMs);
  d.setUTCMinutes(0, 0, 0);
  d.setUTCHours(d.getUTCHours() + 1);
  return d.getTime();
}

/**
 * Attempts to claim one send slot for `sender` in the current hour window.
 * Returns true if allowed (counter incremented), false if the sender is
 * already at the hourly cap (counter left unchanged).
 *
 * `limit` is the per-batch cap chosen in the Compose UI (scheduled_emails.
 * hourly_limit), already validated at schedule time to be <=
 * MAX_EMAILS_PER_HOUR_PER_SENDER. That env var is still applied here as a
 * hard floor/ceiling so a bad or missing per-row value can never exceed the
 * server's absolute safety maximum, regardless of what was stored.
 */
export async function tryClaimSendSlot(
  sender: string,
  limit: number,
  atMs = Date.now()
): Promise<boolean> {
  const effectiveLimit = Math.min(
    Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : env.maxEmailsPerHourPerSender,
    env.maxEmailsPerHourPerSender
  );

  const key = hourWindowKey(sender, atMs);
  const count = await redisConnection.incr(key);
  if (count === 1) {
    // First increment in this window — set expiry so old windows don't leak.
    await redisConnection.expire(key, 3600 * 2);
  }
  if (count > effectiveLimit) {
    await redisConnection.decr(key); // give the slot back, we're not using it
    return false;
  }
  return true;
}

/**
 * Gives back a slot claimed by tryClaimSendSlot when the send it was
 * claimed for ultimately failed (transient SMTP error, etc.) — a failed
 * attempt shouldn't count against the sender's hourly quota, only
 * confirmed sends should. Uses the same hour-bucket key derivation, so it
 * must be called with the same `atMs` that was used to claim the slot.
 */
export async function releaseSendSlot(sender: string, atMs = Date.now()): Promise<void> {
  const key = hourWindowKey(sender, atMs);
  await redisConnection.decr(key);
}
