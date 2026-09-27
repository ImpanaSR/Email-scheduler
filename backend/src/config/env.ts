import dotenv from "dotenv";
dotenv.config();

function required(name: string, fallback?: string): string {
  const v = process.env[name] ?? fallback;
  if (v === undefined) {
    throw new Error(`Missing required env var: ${name}`);
  }
  return v;
}

export const env = {
  port: parseInt(process.env.PORT || "4000", 10),
  frontendUrl: required("FRONTEND_URL", "http://localhost:5173"),
  jwtSecret: required("JWT_SECRET", "dev-secret-change-me"),

  databaseUrl: required("DATABASE_URL"),
  redisUrl: required("REDIS_URL", "redis://localhost:6379"),

  etherealUser: process.env.ETHEREAL_USER || "",
  etherealPass: process.env.ETHEREAL_PASS || "",

  googleClientId: process.env.GOOGLE_CLIENT_ID || "",
  googleClientSecret: process.env.GOOGLE_CLIENT_SECRET || "",
  googleCallbackUrl: process.env.GOOGLE_CALLBACK_URL || "http://localhost:4000/auth/google/callback",

  slackClientId: process.env.SLACK_CLIENT_ID || "",
  slackClientSecret: process.env.SLACK_CLIENT_SECRET || "",
  slackRedirectUri: process.env.SLACK_REDIRECT_URI || "http://localhost:4000/slack/callback",

  elasticsearchUrl: process.env.ELASTICSEARCH_URL || "http://localhost:9200",
  elasticsearchIndex: process.env.ELASTICSEARCH_INDEX || "emails",

  workerConcurrency: parseInt(process.env.WORKER_CONCURRENCY || "5", 10),
  minDelayMsBetweenSends: parseInt(process.env.MIN_DELAY_MS_BETWEEN_SENDS || "2000", 10),
  maxEmailsPerHourPerSender: parseInt(process.env.MAX_EMAILS_PER_HOUR_PER_SENDER || "200", 10),
};
