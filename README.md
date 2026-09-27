# ReachInbox Scheduler

A production-style email scheduler: a Node/TypeScript/Express backend with
BullMQ + Redis for delayed, persistent job scheduling; Postgres as the
source of truth; Ethereal (fake SMTP) for sending; Elasticsearch for search;
Slack notifications on rate-limit hits; Google OAuth login; and a polished
React dashboard to compose, view, and search scheduled/sent emails.

## What was actually verified vs. what needs your own credentials

I ran this against a **real Postgres + Redis stack** (installed locally,
not mocked) across two passes — the initial build, and a later audit pass
that tightened a few things — driving it with integration tests, the actual
worker process, and direct HTTP smoke tests against a running API server.
What's been exercised for real vs. what still needs your own
credentials/network:

**Verified against a live stack:**
- Schema migration runs clean; full authenticated request cycle tested end
  to end via curl against a running server (login-session cookie generated
  directly with the app's own JWT secret, since real Google OAuth needs
  credentials I don't have here): `/api/me`, `/api/emails`,
  `/api/emails/schedule` (single recipient and CSV upload), `/api/slack/status`,
  `/slack/connect` redirect, `DELETE /api/slack` — all returned the expected
  status codes and payloads, and every route correctly 401s without a
  session.
- CSV lead upload correctly de-duplicates recipients (verified with a
  4-row file containing one duplicate address → 3 scheduled).
- The DB-level idempotency guard: claiming the same row twice — the second
  claim correctly gets nothing back, so a duplicate/retried job can't send
  twice.
- The Redis-backed per-sender hourly rate limiter: claims increment a real
  Redis counter, a claim past the cap is correctly rejected without
  drifting the counter, and a released slot (failed send) correctly returns
  to 0.
- **Rate-limit rescheduling, watched live:** pre-seeded the Redis counter to
  the cap, ran the real worker against real jobs, and watched three emails
  for the same sender all get pushed to the next hour via BullMQ's native
  `job.moveToDelayed()` — confirmed via the worker's own logs *and* by
  querying Postgres afterward (rows correctly back to `scheduled` with the
  pushed time) *and* by inspecting Redis directly (still exactly one BullMQ
  job per row — `email-<rowId>` — no duplicates left behind by the push).
- Recovery: a row deliberately left stuck in `processing` (simulating a
  worker that died mid-send) is correctly reset to `scheduled` and re-armed
  with a fresh BullMQ job on the next boot.
- Slack connect → disconnect → reconnect lifecycle, tested at the service
  level: silent no-op with nothing connected, works immediately after
  connecting, back to silent no-op after disconnecting, works again
  immediately after reconnecting — no restart needed at any step.
- Both `backend` and `frontend` typecheck and build cleanly (`tsc`, `tsc -b`,
  `vite build`) after every change in this pass.
- Elasticsearch itself wasn't installed in this environment either time,
  but its absence was exercised for real: indexing/search calls correctly
  log a warning and degrade (empty search results, no crash) instead of
  breaking scheduling, sending, or search requests — confirmed via the
  running server's logs and a live `GET /api/emails/search` call returning
  `200 []` instead of erroring.

**This audit pass found and fixed two real gaps, not just polish:**
1. A transient SMTP failure was silently consuming a sender's hourly quota
   (the rate-limit slot was claimed before sending but only released if
   *rejected*, not if the send itself failed) — fixed with `releaseSendSlot`.
2. Rate-limit deferrals were originally implemented by spawning a **new**
   BullMQ job under a suffixed ID each time a sender got pushed to the next
   hour, leaving the original job to complete as a no-op. Under sustained
   load (a sender capped for many consecutive hours) this would slowly
   accumulate throwaway completed-job history, and — more importantly — it
   meant "one job per email" wasn't quite true across a reschedule. Replaced
   with BullMQ's native `job.moveToDelayed()` + `DelayedError`, so a given
   email row has exactly **one** job for its *entire* lifetime, no matter
   how many times it gets deferred.

**You still need to test locally, with your own credentials/network:**
- An actual email landing in an Ethereal inbox (send calls fail in this
  sandbox purely because outbound network here is restricted to package
  registries — `smtp.ethereal.email` isn't reachable — the code path itself
  was exercised, including its failure/retry branch, just not a real deliver).
- Google OAuth and Slack OAuth — both need your own app credentials (see
  below); I simulated an authenticated session directly for testing rather
  than faking OAuth.
- A real Elasticsearch instance for actual indexing/search round-trips.
- The "restart survives" and "rate limit → Slack message" scenarios for
  your demo video, end-to-end, on your machine.

I'm calling this out explicitly rather than just saying "tested" because
those are genuinely different claims, and I'd rather you know exactly which
parts have been exercised for real.

---

## Architecture overview

```
reachinbox-scheduler/
├── backend/            Express API + BullMQ worker (TypeScript)
├── frontend/            React + Vite + Tailwind dashboard
└── docker-compose.yml   Postgres + Redis + Elasticsearch
```

### Why one process is two entry points

`npm run dev` starts the **API server** (`src/index.ts`); `npm run worker`
starts the **BullMQ worker** (`src/queue/worker.ts`) as a *separate*
process. This mirrors how you'd actually deploy it (API and worker scale
independently) and makes the "worker concurrency" and "rate limiting is
safe across multiple workers" requirements meaningful — you can run
`npm run worker` twice in two terminals and the Redis-backed rate limiter
still holds the line correctly, because no rate-limit state lives in
process memory.

### Data model

One table, `scheduled_emails`, with a `status` column
(`scheduled → processing → sent` or `failed`). "Sent Emails" in the
dashboard is just `WHERE status = 'sent'`. I deliberately did **not** split
this into two tables — an email doesn't change identity when it's sent, it
changes state, so a status enum is simpler and avoids a move/copy step.

### Scheduling: BullMQ delayed jobs, no cron

When an email is scheduled, we insert a DB row and immediately call
`emailQueue.add(..., { delay })`, where `delay` is the milliseconds until
`scheduled_time`. BullMQ stores this in Redis and the worker picks it up
exactly when it comes due — there's no polling loop and no cron process
anywhere.

### Persistence across restarts

Two layers make this safe:

1. **Redis persistence.** `docker-compose.yml` runs Redis with
   `--appendonly yes`, so queued/delayed jobs survive a Redis container
   restart on their own — this is the normal case, and it's *why* BullMQ+Redis
   is used instead of `setTimeout`/cron in the first place.
2. **DB-driven recovery (`src/queue/recovery.ts`).** On boot, both the API
   and the worker call `recoverPendingEmails()`, which re-adds a BullMQ job
   for every DB row that isn't `sent`/`failed` yet. Job IDs are deterministic
   (`email-<rowId>`), and BullMQ treats adding a job under an ID that
   already exists as a no-op — so this function is always safe to call,
   whether Redis still has the job or not. This covers the harder failure
   mode (Redis losing its data, e.g. a fresh volume) without needing a
   cron-like reconciliation job.

### Idempotency (never send twice)

Two independent guards, deliberately redundant:

- **Queue-level:** deterministic `jobId = email-<rowId>`, unchanged for that
  row's entire lifetime — including across rate-limit deferrals (see below).
  BullMQ itself won't enqueue a second job for the same row, and there is
  never more than one job in Redis representing a given email, no matter
  how many times it gets pushed to a later hour.
- **DB-level:** the worker calls `claimForProcessing(id)`, which is a single
  `UPDATE ... WHERE status = 'scheduled' RETURNING *`. Only one caller can
  ever see the row flip from `scheduled` to `processing`; a duplicate or
  retried job that reaches this point second gets `null` back and does
  nothing. This is what actually matters if a job ever gets processed twice
  (e.g. after a crash-and-redeliver) — the queue-level guard alone isn't
  enough for that case.

A row stuck in `processing` after a hard crash (worker killed mid-send,
before it could record the outcome) is treated as not-yet-sent and reset to
`scheduled` by the same recovery step on next boot.

### Concurrency, delay, and rate limiting

- **Worker concurrency:** `WORKER_CONCURRENCY` env var, passed straight to
  BullMQ's `Worker` constructor. Multiple jobs run in parallel up to that
  number; safety across them relies on the idempotency guards above, not on
  serializing everything.
- **Minimum delay between sends:** implemented with BullMQ's built-in
  worker `limiter: { max: 1, duration: MIN_DELAY_MS_BETWEEN_SENDS }`, which
  caps the whole worker to starting at most one job per that window —
  a clean way to mimic provider throttling without hand-rolled timers.
- **Emails-per-hour, per sender:** this is the one that has to survive
  multiple worker processes, so it's a Redis `INCR` on a key
  `rate:<sender>:<hour-bucket>` with a 2-hour expiry (see
  `services/rateLimiter.ts`). No in-memory counters anywhere. When a sender
  is at the cap:
  - the job **does not fail** — it's a designed outcome, not an error;
  - the DB row goes back to `scheduled` with `scheduled_time` moved to the
    start of the next hour window;
  - the **same** BullMQ job (same `jobId`, no new job created) is moved
    forward in time via `job.moveToDelayed()`, BullMQ's built-in mechanism
    for "not now, try again later" as opposed to failure — this keeps the
    "exactly one job per row" invariant true even under sustained,
    repeated deferrals, and doesn't touch the job's `attemptsMade`/backoff
    counters, which stay reserved for genuine send failures;
  - a Slack notification fires (see below) if the user has connected Slack.
  - This preserves order about as well as a simple "push everything over
    the cap into the next hour" strategy reasonably can — it does not try
    to do fair cross-sender scheduling beyond that.
  - The slot itself is only consumed by a *confirmed* send: it's claimed
    optimistically before attempting to send, then given back
    (`releaseSendSlot`) if the send throws — so a run of transient SMTP
    errors doesn't silently burn through a sender's real hourly quota.
- **Under load (1000+ emails at once):** nothing here assumes small
  volume — the DB is the queue of record, delayed jobs are cheap in Redis,
  and the hourly cap logic above kicks in identically whether 5 or 5,000
  emails land in the same window; excess simply spills into subsequent
  hours, sender by sender, without spawning extra jobs per deferral.

### Slack notifications

Real OAuth v2 flow (`/slack/connect` → Slack's authorize page →
`/slack/callback`), storing the per-workspace **incoming webhook URL**
returned by Slack per user in Postgres. Sending a notification later is a
plain `POST` to that stored URL — no token refresh logic needed for
incoming webhooks. If a user hasn't connected Slack,
`getSlackWebhook()` returns `null` and `notifyRateLimitHit()` is a silent
no-op (no crash); once they connect, the very next check reads the fresh
row from the DB — no redeploy required. `DELETE /api/slack` disconnects
(removes the stored row) — the dashboard's Slack menu exposes this — and
reconnecting afterward works immediately for the same reason: every check
reads live from Postgres, there's no cached "connected" state anywhere to
go stale.

### Elasticsearch

A minimal HTTP-only client (no ES client library, to keep the dependency
list small) in `services/searchService.ts`. An email is indexed the moment
it's scheduled (status: `scheduled`) so it's searchable right away, not
just once it's sent, and re-indexed with its final status when the worker
marks it `sent` or `failed`. `/api/emails/search?q=...` runs a
`multi_match` across subject/body/recipient/sender, scoped to the logged-in
user. If Elasticsearch is unreachable, indexing/search calls log a warning
and return an empty result instead of throwing — scheduling and sending
keep working either way.

### Google OAuth

Implemented as plain `fetch` calls against Google's token and userinfo
endpoints (no `passport` dependency) — it's a short, linear flow and easier
to read end-to-end than a strategy-object abstraction for a project this
size. Session is a signed JWT in an httpOnly cookie; `requireAuth`
middleware verifies it on every API route.

### CSV upload

`multer` (memory storage) + `csv-parse` on the backend; the frontend also
does a quick client-side regex scan purely so the compose modal can show a
live "N email addresses detected" count before you submit. The backend
re-parses the file itself and is the authoritative source — the
client-side count is just UX feedback. Duplicate addresses in the file are
de-duplicated server-side before scheduling.

### Frontend

React + Vite + Tailwind, styled as an actual small SaaS dashboard rather
than a default-Bootstrap-looking demo:

- A shared design system (`tailwind.config.js`): a brand color scale, a
  couple of custom shadows for cards/popovers, Inter as the base font, and
  small enter animations for modals/toasts/dropdowns.
- Reusable primitives (`components/Button.tsx`, `Field.tsx`, `Modal.tsx`,
  `StatusBadge.tsx`) so every button, input, and badge in the app looks and
  behaves consistently instead of being styled ad hoc per screen.
- A real toast notification system (`components/Toast.tsx`) for success/
  error/info feedback — replacing raw `alert()` calls — used for schedule
  confirmations, Slack connect/disconnect feedback, and load/search errors.
- Skeleton loading rows and richer empty states (icon + message) in the
  email tables, instead of a bare "Loading…"/"No data" string.
- A drag-and-drop-style CSV dropzone in the compose modal with a live
  detected-recipient-count chip, instead of a bare file input.
- A header with a Slack connection indicator (shows the connected
  workspace name, with a dropdown to disconnect) and a user menu (avatar,
  name, email, logout) — dropdowns close on outside click and `Esc`.
- Two small stat cards (scheduled / sent counts) above the table for an
  at-a-glance summary, refreshed on the same 5-second poll as the table.
- Responsive down to mobile widths — the header collapses to icons only,
  the stat cards and search bar stack, and wide tables scroll horizontally
  inside their own container instead of the page.
- One added dependency, `lucide-react`, for icons — no UI kit, animation
  library, or CSS framework beyond the Tailwind that was already there.

---

## Running it locally

### 1. Infra

```bash
docker-compose up -d
```

This starts Postgres (`localhost:5432`), Redis (`localhost:6379`), and
Elasticsearch (`localhost:9200`).

### 2. Backend

```bash
cd backend
cp .env.example .env
npm install
npm run migrate      # creates tables
npm run dev          # API server on :4000
```

In a second terminal:

```bash
cd backend
npm run worker       # BullMQ worker
```

**Ethereal Email:** if you leave `ETHEREAL_USER`/`ETHEREAL_PASS` blank, the
worker creates a temporary test inbox on first send and prints the
credentials to its log — copy them into `.env` so you keep the same inbox
across restarts (otherwise every restart gets a fresh, empty inbox). Every
sent email's Ethereal preview link is also shown in the "Sent Emails" tab.

**Google OAuth:** create an OAuth 2.0 Client ID at
[Google Cloud Console](https://console.cloud.google.com/apis/credentials)
(type "Web application"), add
`http://localhost:4000/auth/google/callback` as an authorized redirect URI,
and put the client ID/secret in `.env`.

**Slack:** create an app at [api.slack.com/apps](https://api.slack.com/apps),
add the `incoming-webhook` OAuth scope, set the redirect URL to
`http://localhost:4000/slack/callback`, and put the client ID/secret in
`.env`.

**Elasticsearch:** no setup needed beyond it being reachable — the backend
creates the index itself on boot if it doesn't exist.

### 3. Frontend

```bash
cd frontend
cp .env.example .env
npm install
npm run dev           # http://localhost:5173
```

### 4. BullMQ dashboard

Once the API server is running: **http://localhost:4000/admin/queues** —
live view of waiting/active/delayed/failed jobs.

---

## Environment variables

See `backend/.env.example` and `frontend/.env.example` for the full list
with comments. Nothing is hardcoded — every tunable (worker concurrency,
min delay between sends, per-sender hourly cap, all URLs/secrets) is an
env var.

## Testing the key scenarios

- **Basic scheduling:** log in, compose an email with a start time a minute
  or two out, watch it move from Scheduled → Sent, click the preview link.
- **Restart survives / no duplicate sends:** schedule something 2–3 minutes
  out, stop the worker process, restart it — it should still send at the
  original time, exactly once. To test the harder Redis-data-loss path,
  `docker-compose down -v` between scheduling and restarting (this wipes
  the Redis volume) and confirm the recovery step in the API/worker logs
  re-arms the job from Postgres.
- **Rate limiting:** set `MAX_EMAILS_PER_HOUR_PER_SENDER=2` in `.env`,
  schedule 4+ emails for the same sender at the same time, connect Slack
  first — you should see 2 send immediately and the rest get pushed to the
  next hour with a Slack message.
- **Slack disconnect/reconnect:** click the Slack indicator in the header →
  Disconnect, trigger a rate-limit hit — no notification, no crash. Click
  "Connect Slack" again — the very next rate-limit hit notifies, no restart
  needed.
- **Search:** after a few emails have sent, use the dashboard search box.

## Known simplifications / trade-offs

- The compose form's "delay between emails" and "hourly limit" fields
  control how a single batch is spaced client-side; the actual hard,
  enforced cap is always the server-side `MAX_EMAILS_PER_HOUR_PER_SENDER`
  env var, per the assignment's "must be configurable via env/config, not
  hardcoded" requirement. I chose not to let each request override the
  server's enforced limit, since a client-supplied rate limit isn't really
  a safety limit.
- The rate-limit "push to next hour" strategy preserves rough ordering but
  doesn't do anything fancier (e.g. weighted fairness across senders) —
  kept intentionally simple per the assignment's own guidance.
- No refresh-token handling for Google (7-day JWT session instead) — fine
  for a demo, would need real refresh-token storage for a long-lived app.
- Elasticsearch and Slack both degrade gracefully rather than blocking
  core functionality if unreachable/not connected, per the assignment's
  own "no crash" wording for the Slack case, extended to ES for the same
  reason.
- The hourly rate-limit slot is claimed for the whole duration of a send
  attempt (not just after confirmed success), so a slow SMTP call briefly
  "holds" a slot rather than only counting after it completes — a
  reasonable trade-off for a single-attempt-at-a-time-per-slot model, but
  worth knowing if you extend this.
- The dashboard polls every 5 seconds rather than using WebSockets/SSE for
  live updates — simpler to reason about and demo, at the cost of a small
  delay before a status change shows up.
