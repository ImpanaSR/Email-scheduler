import { Queue } from "bullmq";
import { redisConnection } from "./redisConnection";

export const EMAIL_QUEUE_NAME = "email-send-queue";

export const emailQueue = new Queue(EMAIL_QUEUE_NAME, {
  connection: redisConnection,
  defaultJobOptions: {
    attempts: 5,
    backoff: { type: "exponential", delay: 5000 },
    removeOnComplete: { age: 3600 * 24, count: 5000 }, // keep history bounded
    removeOnFail: { age: 3600 * 24 * 7 },
  },
});

export interface EmailJobPayload {
  emailRowId: number;
}

/**
 * Schedule (or re-schedule) a delayed job for a given DB row.
 * jobId is deterministic (`email-<rowId>`) — there is exactly one BullMQ
 * job per email row for that row's entire lifetime. Re-adding the same row
 * (e.g. from the startup recovery pass) is a safe no-op if a job for it
 * already exists in Redis; this is the queue-level half of our idempotency
 * guarantee. Rate-limit deferrals move this same job forward in time via
 * `job.moveToDelayed()` (see worker.ts) rather than creating a new job, so
 * the jobId never changes after creation.
 */
export async function scheduleEmailJob(emailRowId: number, scheduledTimeMs: number) {
  const delay = Math.max(0, scheduledTimeMs - Date.now());
  const jobId = `email-${emailRowId}`;
  await emailQueue.add(
    "send-email",
    { emailRowId } as EmailJobPayload,
    { jobId, delay }
  );
  return jobId;
}
