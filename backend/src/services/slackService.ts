import { pool } from "../db/pool";
import { env } from "../config/env";

/**
 * Slack integration via the standard OAuth v2 "incoming webhook" flow
 * (https://api.slack.com/authentication/oauth-v2 +
 *  https://api.slack.com/messaging/webhooks). The user clicks "Connect
 * Slack" -> Slack's authorize page -> Slack redirects back to our
 * /slack/callback with a `code` -> we exchange it for an access token +
 * a per-channel incoming webhook URL, which we store per user. Sending a
 * notification later is then just a plain POST to that webhook URL — no
 * token juggling needed at send time.
 */

export function buildSlackAuthorizeUrl(userId: number): string {
  const params = new URLSearchParams({
    client_id: env.slackClientId,
    scope: "incoming-webhook",
    redirect_uri: env.slackRedirectUri,
    state: String(userId), // ties the callback back to the right user
  });
  return `https://slack.com/oauth/v2/authorize?${params.toString()}`;
}

export async function exchangeSlackCode(code: string): Promise<{
  accessToken: string;
  webhookUrl: string;
  channel: string;
  teamName: string;
}> {
  const resp = await fetch("https://slack.com/api/oauth.v2.access", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: env.slackClientId,
      client_secret: env.slackClientSecret,
      code,
      redirect_uri: env.slackRedirectUri,
    }),
  });
  const data: any = await resp.json();
  if (!data.ok) {
    throw new Error(`Slack OAuth exchange failed: ${data.error || "unknown_error"}`);
  }
  return {
    accessToken: data.access_token,
    webhookUrl: data.incoming_webhook.url,
    channel: data.incoming_webhook.channel,
    teamName: data.team?.name || "unknown",
  };
}

export async function saveSlackIntegration(
  userId: number,
  info: { accessToken: string; webhookUrl: string; channel: string; teamName: string }
) {
  await pool.query(
    `INSERT INTO slack_integrations (user_id, team_name, access_token, webhook_url, channel)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (user_id) DO UPDATE
       SET team_name = EXCLUDED.team_name,
           access_token = EXCLUDED.access_token,
           webhook_url = EXCLUDED.webhook_url,
           channel = EXCLUDED.channel`,
    [userId, info.teamName, info.accessToken, info.webhookUrl, info.channel]
  );
}

export async function getSlackWebhook(userId: number): Promise<string | null> {
  const { rows } = await pool.query(
    `SELECT webhook_url FROM slack_integrations WHERE user_id = $1`,
    [userId]
  );
  return rows[0]?.webhook_url ?? null;
}

export async function getSlackIntegration(
  userId: number
): Promise<{ teamName: string; channel: string } | null> {
  const { rows } = await pool.query(
    `SELECT team_name, channel FROM slack_integrations WHERE user_id = $1`,
    [userId]
  );
  if (!rows[0]) return null;
  return { teamName: rows[0].team_name, channel: rows[0].channel };
}

export async function removeSlackIntegration(userId: number): Promise<void> {
  await pool.query(`DELETE FROM slack_integrations WHERE user_id = $1`, [userId]);
}

/**
 * Sends a rate-limit-hit notification if (and only if) this user has
 * connected Slack. Never throws — a Slack failure must not crash the
 * worker or fail the underlying email job. If the user hasn't connected
 * Slack, this is a silent no-op (as required), and if they connect later,
 * notifications start working immediately since we read the webhook URL
 * fresh from the DB on every call — no redeploy needed.
 */
export async function notifyRateLimitHit(userId: number, sender: string) {
  try {
    const webhookUrl = await getSlackWebhook(userId);
    if (!webhookUrl) {
      console.warn(`[slackService] No Slack integration for user ${userId} — skipping notification.`);
      return;
    }
    const resp = await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        text: `:hourglass_flowing_sand: Hourly send limit reached for sender *${sender}*. Remaining emails have been pushed to the next hour window.`,
      }),
    });
    // Slack's webhook endpoint does NOT throw on failure (expired/revoked
    // webhook, wrong channel, etc.) — it returns a normal HTTP response with
    // a non-200 status and a plaintext error body (e.g. "invalid_token").
    // Without checking resp.ok, a failing webhook looked identical to a
    // successful one: no thrown error, nothing in the logs.
    if (!resp.ok) {
      const detail = await resp.text().catch(() => "");
      console.error(
        `[slackService] Slack webhook rejected notification for user ${userId} (status ${resp.status}): ${detail}`
      );
    }
  } catch (err) {
    console.error("[slackService] Failed to send rate-limit notification:", err);
  }
}
