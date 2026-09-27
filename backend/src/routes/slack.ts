import { Router } from "express";
import { env } from "../config/env";
import { requireAuth, AuthedRequest } from "../middleware/auth";
import {
  buildSlackAuthorizeUrl,
  exchangeSlackCode,
  saveSlackIntegration,
  getSlackIntegration,
  removeSlackIntegration,
} from "../services/slackService";

export const slackRouter = Router();

slackRouter.get("/slack/connect", requireAuth, (req: AuthedRequest, res) => {
  res.redirect(buildSlackAuthorizeUrl(req.userId!));
});

slackRouter.get("/slack/callback", async (req, res) => {
  const code = req.query.code as string | undefined;
  const state = req.query.state as string | undefined; // userId
  if (!code || !state) return res.status(400).send("Missing code/state");

  try {
    const info = await exchangeSlackCode(code);
    await saveSlackIntegration(parseInt(state, 10), info);
    res.redirect(`${env.frontendUrl}/dashboard?slack=connected`);
  } catch (err) {
    console.error("[slack] OAuth callback failed:", err);
    res.redirect(`${env.frontendUrl}/dashboard?slack=error`);
  }
});

slackRouter.get("/api/slack/status", requireAuth, async (req: AuthedRequest, res) => {
  const integration = await getSlackIntegration(req.userId!);
  res.json({ connected: !!integration, teamName: integration?.teamName, channel: integration?.channel });
});

// Disconnect: removing the row makes notifyRateLimitHit() a silent no-op
// again immediately (it reads fresh from the DB on every call), and
// reconnecting later (hitting /slack/connect again) starts notifications
// again immediately too — neither direction needs a restart/redeploy.
slackRouter.delete("/api/slack", requireAuth, async (req: AuthedRequest, res) => {
  await removeSlackIntegration(req.userId!);
  res.json({ ok: true });
});
