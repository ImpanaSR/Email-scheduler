const API_URL = import.meta.env.PROD ? "" : import.meta.env.VITE_API_URL || "http://localhost:4000";

export interface Me {
  id: number;
  email: string;
  name: string;
  avatarUrl: string;
}

export interface SlackStatus {
  connected: boolean;
  teamName?: string;
  channel?: string;
}

export interface EmailRow {
  id: number;
  sender: string;
  recipient: string;
  subject: string;
  body: string;
  scheduled_time: string;
  status: "scheduled" | "processing" | "sent" | "failed";
  preview_url: string | null;
  error: string | null;
  sent_time: string | null;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const resp = await fetch(`${API_URL}${path}`, {
    credentials: "include",
    ...init,
  });
  if (!resp.ok) {
    const body = await resp.json().catch(() => ({}));
    throw new Error(body.error || `Request failed: ${resp.status}`);
  }
  return resp.json();
}

export const api = {
  googleLoginUrl: () => `${API_URL}/auth/google`,
  slackConnectUrl: () => `${API_URL}/slack/connect`,

  me: () => request<Me>("/api/me"),
  logout: () => request<{ ok: boolean }>("/auth/logout", { method: "POST" }),

  slackStatus: () => request<SlackStatus>("/api/slack/status"),
  slackDisconnect: () => request<{ ok: boolean }>("/api/slack", { method: "DELETE" }),

  listEmails: (status?: "scheduled" | "sent") =>
    request<EmailRow[]>(`/api/emails${status ? `?status=${status}` : ""}`),

  searchEmails: (q: string) => request<any[]>(`/api/emails/search?q=${encodeURIComponent(q)}`),

  scheduleEmails: (form: FormData) =>
    request<{ scheduledCount: number; recipients: string[] }>("/api/emails/schedule", {
      method: "POST",
      body: form,
    }),
};
