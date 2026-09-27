import { Router } from "express";
import multer from "multer";
import { parse } from "csv-parse/sync";
import { requireAuth, AuthedRequest } from "../middleware/auth";
import { createScheduledEmail, setJobId, listByUser } from "../db/emailsRepo";
import { getUserById } from "../db/usersRepo";
import { scheduleEmailJob } from "../queue/emailQueue";
import { searchEmails, indexEmail } from "../services/searchService";
import { env } from "../config/env";

export const emailsRouter = Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 2 * 1024 * 1024 } });

const EMAIL_REGEX = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;

/** Pulls every email-looking token out of a CSV buffer, de-duplicated. */
function extractEmailsFromCsv(buffer: Buffer): string[] {
  const text = buffer.toString("utf-8");
  let found: string[] = [];
  try {
    const records: string[][] = parse(text, { skip_empty_lines: true });
    for (const row of records) {
      for (const cell of row) {
        const matches = cell.match(EMAIL_REGEX);
        if (matches) found.push(...matches);
      }
    }
  } catch {
    // Not valid CSV — fall back to scanning the raw text for email tokens.
    const matches = text.match(EMAIL_REGEX);
    if (matches) found.push(...matches);
  }
  return Array.from(new Set(found.map((e) => e.toLowerCase())));
}

/**
 * POST /api/emails/schedule
 * multipart/form-data:
 *   subject, body, startTime (ISO string), delayBetweenEmailsMs (number)
 *   recipient (optional single recipient, used when no file is uploaded)
 *   leads (optional CSV file of recipient addresses)
 *
 * Every recipient becomes its own scheduled_emails row + its own delayed
 * BullMQ job, spaced out by delayBetweenEmailsMs starting at startTime.
 * hourlyLimit is the batch's requested emails/hour cap, validated here
 * against MAX_EMAILS_PER_HOUR_PER_SENDER and stored on each row; it's
 * enforced at send time by the worker (see rateLimiter.ts) regardless of
 * how these are spaced here.
 */
emailsRouter.post("/api/emails/schedule", requireAuth, upload.single("leads"), async (req: AuthedRequest, res) => {
  try {
    const { subject, body, startTime, delayBetweenEmailsMs, recipient, hourlyLimit } = req.body;
    if (!subject || !body || !startTime) {
      return res.status(400).json({ error: "subject, body and startTime are required" });
    }

    // The Compose UI's "Limit (emails per hour)" field is untrusted input —
    // validate it and never let it exceed the server's own safety cap
    // (MAX_EMAILS_PER_HOUR_PER_SENDER). This value becomes the per-batch
    // limit the worker/rate limiter enforces for these emails' sender.
    const parsedHourlyLimit = Number(hourlyLimit);
    if (
      hourlyLimit === undefined ||
      hourlyLimit === null ||
      hourlyLimit === "" ||
      !Number.isFinite(parsedHourlyLimit) ||
      !Number.isInteger(parsedHourlyLimit) ||
      parsedHourlyLimit < 1
    ) {
      return res.status(400).json({ error: "hourlyLimit must be a positive integer" });
    }
    if (parsedHourlyLimit > env.maxEmailsPerHourPerSender) {
      return res.status(400).json({
        error: `hourlyLimit cannot exceed the server maximum of ${env.maxEmailsPerHourPerSender} emails/hour`,
      });
    }

    let recipients: string[] = [];
    if (req.file) {
      recipients = extractEmailsFromCsv(req.file.buffer);
    } else if (recipient) {
      recipients = [recipient];
    }
    if (recipients.length === 0) {
      return res.status(400).json({ error: "No recipients found — provide a recipient or upload a CSV of leads" });
    }

    const user = await getUserById(req.userId!);
    const sender = user!.email;
    const startMs = new Date(startTime).getTime();
    if (Number.isNaN(startMs)) return res.status(400).json({ error: "Invalid startTime" });
    const spacingMs = Math.max(0, parseInt(delayBetweenEmailsMs, 10) || 0);

    const created = [];
    for (let i = 0; i < recipients.length; i++) {
      const scheduledTime = new Date(startMs + i * spacingMs);
      const row = await createScheduledEmail({
        userId: req.userId!,
        sender,
        recipient: recipients[i],
        subject,
        body,
        scheduledTime,
        hourlyLimit: parsedHourlyLimit,
      });
      const jobId = await scheduleEmailJob(row.id, scheduledTime.getTime());
      await setJobId(row.id, jobId);
      // Index immediately (status: 'scheduled') so it's searchable right
      // away, not just once it's actually sent — the worker re-indexes it
      // later with the final status (sent/failed).
      await indexEmail({
        id: row.id,
        userId: row.user_id,
        sender: row.sender,
        recipient: row.recipient,
        subject: row.subject,
        body: row.body,
        status: row.status,
        scheduledTime: row.scheduled_time.toISOString(),
        sentTime: null,
      });
      created.push(row);
    }

    res.json({ scheduledCount: created.length, recipients });
  } catch (err) {
    console.error("[emails] schedule failed:", err);
    res.status(500).json({ error: "Failed to schedule emails" });
  }
});

emailsRouter.get("/api/emails", requireAuth, async (req: AuthedRequest, res) => {
  const status = req.query.status as "scheduled" | "sent" | "failed" | undefined;
  const rows = await listByUser(req.userId!, status);
  res.json(rows);
});

emailsRouter.get("/api/emails/search", requireAuth, async (req: AuthedRequest, res) => {
  const q = (req.query.q as string) || "";
  if (!q.trim()) return res.json([]);
  const results = await searchEmails(req.userId!, q);
  res.json(results);
});
