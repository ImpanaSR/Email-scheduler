import { pool } from "./pool";

export type EmailStatus = "scheduled" | "processing" | "sent" | "failed";

export interface EmailRow {
  id: number;
  user_id: number;
  sender: string;
  recipient: string;
  subject: string;
  body: string;
  scheduled_time: Date;
  status: EmailStatus;
  job_id: string | null;
  hourly_limit: number;
  preview_url: string | null;
  error: string | null;
  sent_time: Date | null;
  created_at: Date;
}

export async function createScheduledEmail(params: {
  userId: number;
  sender: string;
  recipient: string;
  subject: string;
  body: string;
  scheduledTime: Date;
  hourlyLimit: number;
}): Promise<EmailRow> {
  const { rows } = await pool.query<EmailRow>(
    `INSERT INTO scheduled_emails (user_id, sender, recipient, subject, body, scheduled_time, hourly_limit)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING *`,
    [
      params.userId,
      params.sender,
      params.recipient,
      params.subject,
      params.body,
      params.scheduledTime,
      params.hourlyLimit,
    ]
  );
  return rows[0];
}

export async function setJobId(id: number, jobId: string): Promise<void> {
  await pool.query(`UPDATE scheduled_emails SET job_id = $1 WHERE id = $2`, [jobId, id]);
}

export async function getEmailById(id: number): Promise<EmailRow | null> {
  const { rows } = await pool.query<EmailRow>(`SELECT * FROM scheduled_emails WHERE id = $1`, [id]);
  return rows[0] ?? null;
}

/**
 * Atomically claims a 'scheduled' row for processing by flipping it to
 * 'processing' in one statement. This is the DB-level half of our
 * idempotency guarantee: if two workers (or a retried job) ever raced on
 * the same row, only one UPDATE would actually match `status = 'scheduled'`
 * and return a row — the other gets nothing back and must not send.
 */
export async function claimForProcessing(id: number): Promise<EmailRow | null> {
  const { rows } = await pool.query<EmailRow>(
    `UPDATE scheduled_emails
     SET status = 'processing'
     WHERE id = $1 AND status = 'scheduled'
     RETURNING *`,
    [id]
  );
  return rows[0] ?? null;
}

/** Releases a claimed row back to 'scheduled' (used when we defer for rate limiting). */
export async function releaseBackToScheduled(id: number, newScheduledTime: Date): Promise<void> {
  await pool.query(
    `UPDATE scheduled_emails SET status = 'scheduled', scheduled_time = $2 WHERE id = $1`,
    [id, newScheduledTime]
  );
}

export async function markSent(id: number, previewUrl: string | null): Promise<EmailRow> {
  const { rows } = await pool.query<EmailRow>(
    `UPDATE scheduled_emails
     SET status = 'sent', sent_time = NOW(), preview_url = $2
     WHERE id = $1
     RETURNING *`,
    [id, previewUrl]
  );
  return rows[0];
}

export async function markFailed(id: number, error: string): Promise<EmailRow> {
  const { rows } = await pool.query<EmailRow>(
    `UPDATE scheduled_emails SET status = 'failed', error = $2 WHERE id = $1 RETURNING *`,
    [id, error.slice(0, 2000)]
  );
  return rows[0];
}

export async function listByUser(userId: number, status?: EmailStatus): Promise<EmailRow[]> {
  if (status) {
    const { rows } = await pool.query<EmailRow>(
      `SELECT * FROM scheduled_emails WHERE user_id = $1 AND status = $2 ORDER BY scheduled_time DESC`,
      [userId, status]
    );
    return rows;
  }
  const { rows } = await pool.query<EmailRow>(
    `SELECT * FROM scheduled_emails WHERE user_id = $1 ORDER BY scheduled_time DESC`,
    [userId]
  );
  return rows;
}

/**
 * Rows still 'scheduled' (or stuck 'processing' from a hard crash) with no
 * live job — used at boot to re-arm the queue after a Redis data loss or
 * a worker crash mid-send, so nothing is silently forgotten.
 */
export async function listPendingForRecovery(): Promise<EmailRow[]> {
  const { rows } = await pool.query<EmailRow>(
    `SELECT * FROM scheduled_emails WHERE status IN ('scheduled', 'processing')`
  );
  return rows;
}

export async function resetStuckProcessingToScheduled(): Promise<void> {
  // A row left 'processing' across a restart means the worker died mid-send
  // before marking the outcome. Treat as not-yet-sent and let it be retried.
  await pool.query(`UPDATE scheduled_emails SET status = 'scheduled' WHERE status = 'processing'`);
}
