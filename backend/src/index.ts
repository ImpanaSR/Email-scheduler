import express from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import { createBullBoard } from "@bull-board/api";
import { BullMQAdapter } from "@bull-board/api/bullMQAdapter";
import { ExpressAdapter } from "@bull-board/express";

import { env } from "./config/env";
import { authRouter } from "./routes/auth";
import { slackRouter } from "./routes/slack";
import { emailsRouter } from "./routes/emails";
import { emailQueue } from "./queue/emailQueue";
import { recoverPendingEmails } from "./queue/recovery";
import { ensureIndex } from "./services/searchService";

async function main() {
  await recoverPendingEmails();
  await ensureIndex();

  const app = express();
  app.use(cors({ origin: env.frontendUrl, credentials: true }));
  app.use(express.json());
  app.use(cookieParser());

  // Live BullMQ dashboard — real-time view of waiting/active/delayed/failed jobs.
  const serverAdapter = new ExpressAdapter();
  serverAdapter.setBasePath("/admin/queues");
  createBullBoard({
    // Cast: @bull-board's BullMQAdapter typings lag slightly behind the
    // BullMQ version pinned here (progress type widened in newer BullMQ) —
    // functionally compatible, this is a typings-only mismatch.
    queues: [new BullMQAdapter(emailQueue) as any],
    serverAdapter,
  });
  app.use("/admin/queues", serverAdapter.getRouter());

  app.use(authRouter);
  app.use(slackRouter);
  app.use(emailsRouter);

  app.get("/health", (_req, res) => res.json({ ok: true }));

  // Centralized error handler — keeps route handlers free of boilerplate.
  app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    console.error("[unhandled]", err);
    res.status(500).json({ error: "Internal server error" });
  });

  app.listen(env.port, () => {
    console.log(`[server] Listening on http://localhost:${env.port}`);
    console.log(`[server] BullMQ dashboard: http://localhost:${env.port}/admin/queues`);
  });
}

main().catch((err) => {
  console.error("[server] Fatal startup error:", err);
  process.exit(1);
});
