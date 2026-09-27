import { Router } from "express";
import { env } from "../config/env";
import { upsertGoogleUser, getUserById } from "../db/usersRepo";
import { signSession, requireAuth, AUTH_COOKIE, AuthedRequest } from "../middleware/auth";

export const authRouter = Router();

const googleCallbackUrl = env.frontendUrl.startsWith("https://")
  ? new URL("/auth/google/callback", env.frontendUrl).toString()
  : env.googleCallbackUrl;

/**
 * Real Google OAuth 2.0 authorization-code flow, implemented with plain
 * fetch calls against Google's endpoints (no passport dependency, to keep
 * the moving parts easy to follow/explain).
 */

authRouter.get("/auth/google", (req, res) => {
  const params = new URLSearchParams({
    client_id: env.googleClientId,
    redirect_uri: googleCallbackUrl,
    response_type: "code",
    scope: "openid email profile",
    prompt: "select_account",
  });
  res.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`);
});

authRouter.get("/auth/google/callback", async (req, res) => {
  const code = req.query.code as string | undefined;
  if (!code) return res.status(400).send("Missing authorization code");

  try {
    const tokenResp = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code,
        client_id: env.googleClientId,
        client_secret: env.googleClientSecret,
        redirect_uri: googleCallbackUrl,
        grant_type: "authorization_code",
      }),
    });
    const tokenData: any = await tokenResp.json();
    if (!tokenData.access_token) {
      throw new Error(`Google token exchange failed: ${JSON.stringify(tokenData)}`);
    }

    const profileResp = await fetch("https://www.googleapis.com/oauth2/v2/userinfo", {
      headers: { Authorization: `Bearer ${tokenData.access_token}` },
    });
    const profile: any = await profileResp.json();

    const user = await upsertGoogleUser({
      googleId: profile.id,
      email: profile.email,
      name: profile.name || profile.email,
      avatarUrl: profile.picture || "",
    });

    const session = signSession(user.id);
    const isSecureFrontend = env.frontendUrl.startsWith("https://");
    res.cookie(AUTH_COOKIE, session, {
      httpOnly: true,
      sameSite: "lax",
      secure: isSecureFrontend,
      maxAge: 7 * 24 * 3600 * 1000,
    });
    res.redirect(`${env.frontendUrl}/dashboard`);
  } catch (err) {
    console.error("[auth] Google OAuth callback failed:", err);
    res.redirect(`${env.frontendUrl}/login?error=oauth_failed`);
  }
});

authRouter.post("/auth/logout", (req, res) => {
  res.clearCookie(AUTH_COOKIE);
  res.json({ ok: true });
});

authRouter.get("/api/me", requireAuth, async (req: AuthedRequest, res) => {
  const user = await getUserById(req.userId!);
  if (!user) return res.status(404).json({ error: "User not found" });
  res.json({
    id: user.id,
    email: user.email,
    name: user.name,
    avatarUrl: user.avatar_url,
  });
});
