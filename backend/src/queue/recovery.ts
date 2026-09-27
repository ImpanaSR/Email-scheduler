import { listPendingForRecovery, resetStuckProcessingToScheduled } from "../db/emailsRepo";
import { scheduleEmailJob } from "./emailQueue";

/**
 * Runs once at process boot (both API and worker processes can safely call
 * this — it's idempotent).
 *
 * Normally BullMQ jobs survive a restart on their own, because they live in
 * Redis, not in process memory — that's the whole point of using a
 * persistent queue instead of setTimeout/cron. This function exists for the
 * harder case: Redis itself losing its data (e.g. a fresh container with no
 * volume). Postgres remains the source of truth, so we walk every row that
 * isn't finished yet and re-add its job. `scheduleEmailJob` uses a
 * deterministic jobId (`email-<rowId>`) that never changes for that row's
 * entire lifetime (rate-limit deferrals move the existing job rather than
 * creating a new one — see worker.ts), and BullMQ treats adding a job under
 * an id that already exists as a no-op — so this is always safe to run,
 * whether or not the job already exists.
 */
export async function recoverPendingEmails(): Promise<void> {
  // A row stuck in 'processing' means a worker died mid-send before
  // recording the outcome — treat it as not-yet-sent.
  await resetStuckProcessingToScheduled();

  const pending = await listPendingForRecovery();
  for (const row of pending) {
    await scheduleEmailJob(row.id, row.scheduled_time.getTime());
  }
  if (pending.length > 0) {
    console.log(`[recovery] Re-armed ${pending.length} pending email job(s).`);
  }
}
