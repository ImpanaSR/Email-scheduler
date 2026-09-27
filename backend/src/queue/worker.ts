import { Worker, Job, DelayedError } from "bullmq";
import { redisConnection } from "./redisConnection";
import { EMAIL_QUEUE_NAME, EmailJobPayload } from "./emailQueue";
import { env } from "../config/env";
import { claimForProcessing, releaseBackToScheduled, markSent, markFailed } from "../db/emailsRepo";
import { tryClaimSendSlot, releaseSendSlot, nextHourWindowStart } from "../services/rateLimiter";
import { sendEmail } from "../services/emailService";
import { notifyRateLimitHit } from "../services/slackService";
import { indexEmail } from "../services/searchService";
import { recoverPendingEmails } from "./recovery";

async function processEmailJob(job: Job<EmailJobPayload>, token?: string) {
  const { emailRowId } = job.data;

  // --- Idempotency guard #1 (DB): only a row still 'scheduled' gets claimed.
  // If this row was already sent (e.g. a duplicate/retried job), this
  // returns null and we do nothing — no double send.
  const row = await claimForProcessing(emailRowId);
  if (!row) {
    console.log(`[worker] Job ${job.id}: row ${emailRowId} already handled, skipping.`);
    return;
  }

  try {
    // --- Per-sender hourly rate limit (Redis-backed, safe across workers).
    const claimedAtMs = Date.now();
    const allowed = await tryClaimSendSlot(row.sender, row.hourly_limit, claimedAtMs);
    if (!allowed) {
      const nextWindow = nextHourWindowStart(Date.now());
      await releaseBackToScheduled(row.id, new Date(nextWindow));
      // Move THIS SAME job forward in time rather than completing it and
      // spawning a new one under a different id. This is BullMQ's built-in
      // mechanism for "not now, try again later" (as opposed to failure):
      // the job keeps its original id for its entire lifetime, which is
      // exactly what keeps our "one job per email row" idempotency
      // invariant simple — there's never more than one job, ever, for a
      // given row, no matter how many times it gets pushed to a later
      // hour under sustained load.
      await job.moveToDelayed(nextWindow, token);
      await notifyRateLimitHit(row.user_id, row.sender);
      console.log(
        `[worker] Sender ${row.sender} hit hourly cap — email ${row.id} pushed to ${new Date(nextWindow).toISOString()}.`
      );
      // Required by BullMQ after moveToDelayed: signals "don't mark this
      // completed or failed, it's been rescheduled" without touching
      // attemptsMade or triggering our own retry/backoff bookkeeping below.
      throw new DelayedError();
    }

    try {
      const result = await sendEmail({
        from: row.sender,
        to: row.recipient,
        subject: row.subject,
        text: row.body,
      });

      const sentRow = await markSent(row.id, result.previewUrl || null);
      await indexEmail({
        id: sentRow.id,
        userId: sentRow.user_id,
        sender: sentRow.sender,
        recipient: sentRow.recipient,
        subject: sentRow.subject,
        body: sentRow.body,
        status: sentRow.status,
        scheduledTime: sentRow.scheduled_time.toISOString(),
        sentTime: sentRow.sent_time ? sentRow.sent_time.toISOString() : null,
      });
      console.log(`[worker] Sent email ${row.id} to ${row.recipient} (${result.previewUrl || "no preview"})`);
    } catch (sendErr) {
      // The slot was claimed optimistically before the send attempt; since
      // it didn't actually go out, give it back so a transient SMTP error
      // doesn't silently eat into the sender's real hourly quota.
      await releaseSendSlot(row.sender, claimedAtMs);
      throw sendErr;
    }
  } catch (err: any) {
    if (err instanceof DelayedError) {
      // Not a failure — already handled above (rescheduled + notified).
      // Must propagate untouched so BullMQ can complete the state
      // transition; must NOT fall into the failure/retry bookkeeping below.
      throw err;
    }
    const attemptsMax = job.opts.attempts ?? 1;
    const isFinalAttempt = job.attemptsMade + 1 >= attemptsMax;
    if (isFinalAttempt) {
      const failedRow = await markFailed(row.id, err.message || String(err));
      await indexEmail({
        id: failedRow.id,
        userId: failedRow.user_id,
        sender: failedRow.sender,
        recipient: failedRow.recipient,
        subject: failedRow.subject,
        body: failedRow.body,
        status: failedRow.status,
        scheduledTime: failedRow.scheduled_time.toISOString(),
        sentTime: null,
      });
      console.error(`[worker] Email ${row.id} permanently failed:`, err);
    } else {
      // Release the DB claim so the row is 'scheduled' again by the time
      // BullMQ retries this same job after its backoff delay.
      await releaseBackToScheduled(row.id, row.scheduled_time);
      console.warn(`[worker] Email ${row.id} failed (attempt ${job.attemptsMade + 1}/${attemptsMax}), will retry:`, err.message);
    }
    throw err; // let BullMQ's retry/backoff mechanism do its job
  }
}

async function main() {
  await recoverPendingEmails();

  const worker = new Worker<EmailJobPayload>(EMAIL_QUEUE_NAME, processEmailJob, {
    connection: redisConnection,
    concurrency: env.workerConcurrency,
    // Global floor on send rate across this worker: at most 1 job started
    // per MIN_DELAY_MS_BETWEEN_SENDS, mimicking provider throttling.
    limiter: {
      max: 1,
      duration: env.minDelayMsBetweenSends,
    },
  });

  worker.on("failed", (job, err) => {
    console.error(`[worker] Job ${job?.id} failed:`, err.message);
  });

  console.log(
    `[worker] Started. concurrency=${env.workerConcurrency} minDelayMs=${env.minDelayMsBetweenSends} maxPerHourPerSender=${env.maxEmailsPerHourPerSender}`
  );
}

main().catch((err) => {
  console.error("[worker] Fatal startup error:", err);
  process.exit(1);
});
