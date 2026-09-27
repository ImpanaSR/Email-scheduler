import { useEffect, useState, useCallback, useRef } from "react";
import { useNavigate } from "react-router-dom";
import {
  Send,
  Search,
  Plus,
  LogOut,
  Slack as SlackIcon,
  Clock,
  CheckCircle2,
  ChevronDown,
} from "lucide-react";
import { api, Me, EmailRow, SlackStatus } from "../lib/api";
import { Button } from "../components/Button";
import { EmailTable } from "../components/EmailTable";
import { ComposeModal } from "../components/ComposeModal";
import { useToast } from "../components/Toast";

type Tab = "scheduled" | "sent";

export default function DashboardPage() {
  const navigate = useNavigate();
  const toast = useToast();

  const [me, setMe] = useState<Me | null>(null);
  const [tab, setTab] = useState<Tab>("scheduled");
  // Each tab keeps its own cached row list. This means switching tabs never
  // shows the other tab's rows even for an instant, and a background
  // refresh for one tab can never bleed into what's displayed for another.
  const [rowsByTab, setRowsByTab] = useState<Record<Tab, EmailRow[]>>({ scheduled: [], sent: [] });
  // Non-null while a search is active — what's displayed is search results
  // instead of the active tab's cached rows. Clearing search just switches
  // this back to null, instantly restoring the cached tab list with no
  // refetch and no loading flash.
  const [searchResults, setSearchResults] = useState<EmailRow[] | null>(null);
  // `loading` drives the full skeleton — it should only ever be true the
  // very first time a given tab's data is fetched. Every later fetch
  // (polling, post-schedule refresh, tab revisits) is a silent background
  // refresh so the table never flashes back to a skeleton once it has data.
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [composeOpen, setComposeOpen] = useState(false);
  const [slack, setSlack] = useState<SlackStatus>({ connected: false });
  const [slackMenuOpen, setSlackMenuOpen] = useState(false);
  const [userMenuOpen, setUserMenuOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [searching, setSearching] = useState(false);
  const [counts, setCounts] = useState({ scheduled: 0, sent: 0 });

  const rows = searchResults !== null ? searchResults : rowsByTab[tab];

  const slackMenuRef = useRef<HTMLDivElement>(null);
  const userMenuRef = useRef<HTMLDivElement>(null);

  // Keeps `tab`/`search` readable from the polling interval's closure
  // without having to tear down and recreate the interval on every change.
  const tabRef = useRef(tab);
  const searchRef = useRef(search);
  tabRef.current = tab;
  searchRef.current = search;

  // Tabs we've already fetched at least once — used to decide whether a
  // fetch should show the big skeleton (first time) or refresh silently
  // (every time after).
  const loadedTabsRef = useRef<Set<Tab>>(new Set());
  // Per-tab monotonic counters so a slow/late response (from polling, or an
  // overlapping manual refresh) can never clobber a newer response for that
  // *same* tab — this is what was letting the Scheduled tab intermittently
  // show stale or empty data. Kept per-tab (rather than one global counter)
  // so legitimate concurrent loads for different tabs don't cancel each other.
  const requestSeqRef = useRef<Record<Tab, number>>({ scheduled: 0, sent: 0 });
  const searchSeqRef = useRef(0);
  const searchDebounceRef = useRef<ReturnType<typeof setTimeout>>();

  useEffect(() => {
    api
      .me()
      .then(setMe)
      .catch(() => navigate("/login"));
    api.slackStatus().then(setSlack).catch(() => {});

    const params = new URLSearchParams(window.location.search);
    if (params.get("slack") === "connected") toast.show("success", "Slack connected — you'll get notified on rate-limit hits.");
    if (params.get("slack") === "error") toast.show("error", "Slack connection failed. Please try again.");
  }, [navigate]);

  useEffect(() => {
    function onClickOutside(e: MouseEvent) {
      if (slackMenuRef.current && !slackMenuRef.current.contains(e.target as Node)) setSlackMenuOpen(false);
      if (userMenuRef.current && !userMenuRef.current.contains(e.target as Node)) setUserMenuOpen(false);
    }
    document.addEventListener("mousedown", onClickOutside);
    return () => document.removeEventListener("mousedown", onClickOutside);
  }, []);

  /**
   * Fetches the given tab's rows plus both counts. `targetTab` is passed
   * explicitly (rather than read from `tab` state) so an in-flight request
   * always knows which tab it was for, even if the user switches tabs
   * before it resolves.
   *
   * A request sequence number guards every apply: if a newer `load()` (or
   * tab switch) has started by the time this one resolves, its result is
   * discarded instead of overwriting fresher state. This is what was
   * causing the Scheduled tab to intermittently show stale/empty data —
   * the 5s poll, the initial mount fetch, and post-schedule refreshes could
   * all be in flight together with nothing stopping an older one from
   * winning the race and clobbering newer data.
   */
  const load = useCallback(async (targetTab: Tab, opts: { silent?: boolean } = {}) => {
    const seq = ++requestSeqRef.current[targetTab];
    const isCurrentTab = tabRef.current === targetTab;
    const isFirstLoadForTab = !loadedTabsRef.current.has(targetTab);
    if (isCurrentTab && isFirstLoadForTab && !opts.silent) {
      setLoading(true);
    } else if (isCurrentTab) {
      setRefreshing(true);
    }
    try {
      const [tabRows, scheduledRows, sentRows] = await Promise.all([
        api.listEmails(targetTab),
        api.listEmails("scheduled"),
        api.listEmails("sent"),
      ]);
      if (seq !== requestSeqRef.current[targetTab]) return; // a newer load() for this tab superseded this one
      loadedTabsRef.current.add(targetTab);
      setRowsByTab((prev) => ({ ...prev, [targetTab]: tabRows }));
      setCounts({ scheduled: scheduledRows.length, sent: sentRows.length });
    } catch (err: any) {
      if (seq !== requestSeqRef.current[targetTab]) return;
      toast.show("error", err.message || "Failed to load emails.");
    } finally {
      if (seq === requestSeqRef.current[targetTab]) {
        setLoading(false);
        setRefreshing(false);
      }
    }
  }, []);

  /** Counts-only refresh — used while a search is active so background
   * polling doesn't stomp the visible search results with the tab's
   * unfiltered list. */
  const refreshCounts = useCallback(async () => {
    try {
      const [scheduledRows, sentRows] = await Promise.all([api.listEmails("scheduled"), api.listEmails("sent")]);
      setCounts({ scheduled: scheduledRows.length, sent: sentRows.length });
    } catch {
      // Silent — this is a background refresh, not a user-triggered action.
    }
  }, []);

  useEffect(() => {
    load(tab);
  }, [tab, load]);

  // Light polling so newly-sent/rate-limit-deferred emails show up without
  // a manual refresh. Always silent (never shows the skeleton), and skips
  // refreshing the row list while the user has an active search so it
  // doesn't overwrite their search results.
  useEffect(() => {
    const id = setInterval(() => {
      if (searchRef.current.trim()) {
        refreshCounts();
      } else {
        load(tabRef.current, { silent: true });
      }
    }, 5000);
    return () => clearInterval(id);
  }, [load, refreshCounts]);

  useEffect(() => {
    return () => {
      if (searchDebounceRef.current) clearTimeout(searchDebounceRef.current);
    };
  }, []);

  async function runSearch(q: string) {
    const seq = ++searchSeqRef.current;
    setSearching(true);
    try {
      const results = await api.searchEmails(q);
      if (seq !== searchSeqRef.current) return; // a newer search (or a clear) superseded this one
      setSearchResults(
        results.map((r) => ({
          ...r,
          scheduled_time: r.scheduledTime,
          sent_time: r.sentTime,
          preview_url: null,
        }))
      );
    } catch {
      if (seq === searchSeqRef.current) toast.show("error", "Search failed. Try again.");
    } finally {
      if (seq === searchSeqRef.current) setSearching(false);
    }
  }

  function handleSearchChange(q: string) {
    setSearch(q);
    if (searchDebounceRef.current) clearTimeout(searchDebounceRef.current);

    if (!q.trim()) {
      // Invalidate any in-flight search response and instantly restore the
      // active tab's cached list — no refetch, no loading flash.
      searchSeqRef.current++;
      setSearching(false);
      setSearchResults(null);
      return;
    }

    // Debounce so we're not firing a request per keystroke, which was also
    // causing results to flicker as out-of-order responses landed.
    searchDebounceRef.current = setTimeout(() => runSearch(q), 300);
  }

  function handleScheduled() {
    if (search.trim()) {
      refreshCounts();
    } else {
      load(tab, { silent: true });
    }
  }

  async function handleLogout() {
    await api.logout();
    navigate("/login");
  }

  async function handleSlackDisconnect() {
    setSlackMenuOpen(false);
    try {
      await api.slackDisconnect();
      setSlack({ connected: false });
      toast.show("info", "Slack disconnected. Rate-limit alerts are paused.");
    } catch {
      toast.show("error", "Couldn't disconnect Slack. Try again.");
    }
  }

  if (!me) return null;

  return (
    <div className="min-h-screen bg-slate-50">
      <header className="bg-white border-b border-slate-100 sticky top-0 z-30">
        <div className="max-w-6xl mx-auto px-4 sm:px-6 h-16 flex items-center justify-between gap-4">
          <div className="flex items-center gap-2.5 shrink-0">
            <div className="w-8 h-8 rounded-lg bg-brand-600 flex items-center justify-center">
              <Send className="w-4 h-4 text-white" />
            </div>
            <span className="font-semibold text-slate-900 hidden sm:inline">ReachInbox</span>
          </div>

          <div className="flex items-center gap-2 sm:gap-3">
            <div className="relative" ref={slackMenuRef}>
              {slack.connected ? (
                <button
                  onClick={() => setSlackMenuOpen((v) => !v)}
                  className="flex items-center gap-1.5 text-xs font-medium text-emerald-700 bg-emerald-50 ring-1 ring-inset ring-emerald-200 px-2.5 py-1.5 rounded-full hover:bg-emerald-100 transition"
                >
                  <SlackIcon className="w-3.5 h-3.5" />
                  <span className="hidden sm:inline">{slack.teamName || "Slack connected"}</span>
                  <ChevronDown className="w-3 h-3" />
                </button>
              ) : (
                <Button variant="secondary" size="sm" icon={<SlackIcon className="w-3.5 h-3.5" />} onClick={() => (window.location.href = api.slackConnectUrl())}>
                  <span className="hidden sm:inline">Connect Slack</span>
                  <span className="sm:hidden">Slack</span>
                </Button>
              )}
              {slackMenuOpen && slack.connected && (
                <div className="absolute right-0 mt-2 w-56 bg-white rounded-xl shadow-popover border border-slate-100 py-1.5 animate-slide-in">
                  <div className="px-3 py-2 border-b border-slate-50">
                    <p className="text-xs text-slate-400">Notifying</p>
                    <p className="text-sm text-slate-700 font-medium truncate">{slack.channel || "your workspace"}</p>
                  </div>
                  <button
                    onClick={handleSlackDisconnect}
                    className="w-full text-left px-3 py-2 text-sm text-red-600 hover:bg-red-50 transition"
                  >
                    Disconnect Slack
                  </button>
                </div>
              )}
            </div>

            <div className="relative" ref={userMenuRef}>
              <button
                onClick={() => setUserMenuOpen((v) => !v)}
                className="flex items-center gap-2 pl-1 pr-2 py-1 rounded-full hover:bg-slate-50 transition"
              >
                {me.avatarUrl ? (
                  <img src={me.avatarUrl} alt="" className="w-7 h-7 rounded-full" referrerPolicy="no-referrer" />
                ) : (
                  <div className="w-7 h-7 rounded-full bg-brand-100 text-brand-700 flex items-center justify-center text-xs font-semibold">
                    {me.name?.[0]?.toUpperCase() || "U"}
                  </div>
                )}
                <span className="text-sm font-medium text-slate-700 hidden md:inline">{me.name}</span>
                <ChevronDown className="w-3 h-3 text-slate-400 hidden md:inline" />
              </button>
              {userMenuOpen && (
                <div className="absolute right-0 mt-2 w-56 bg-white rounded-xl shadow-popover border border-slate-100 py-1.5 animate-slide-in">
                  <div className="px-3 py-2 border-b border-slate-50">
                    <p className="text-sm text-slate-700 font-medium truncate">{me.name}</p>
                    <p className="text-xs text-slate-400 truncate">{me.email}</p>
                  </div>
                  <button
                    onClick={handleLogout}
                    className="w-full flex items-center gap-2 text-left px-3 py-2 text-sm text-slate-600 hover:bg-slate-50 transition"
                  >
                    <LogOut className="w-3.5 h-3.5" /> Logout
                  </button>
                </div>
              )}
            </div>
          </div>
        </div>
      </header>

      <main className="max-w-6xl mx-auto px-4 sm:px-6 py-8">
        <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-4 mb-6">
          <div>
            <h1 className="text-2xl font-bold text-slate-900">Emails</h1>
            <p className="text-sm text-slate-500 mt-1">Manage and track your scheduled cold email sends.</p>
          </div>
          <Button icon={<Plus className="w-4 h-4" />} onClick={() => setComposeOpen(true)} className="shrink-0">
            Compose New Email
          </Button>
        </div>

        <div className="grid grid-cols-2 gap-4 mb-6">
          <div className="bg-white rounded-xl border border-slate-100 shadow-card px-5 py-4 flex items-center gap-3">
            <div className="w-9 h-9 rounded-lg bg-amber-50 flex items-center justify-center shrink-0">
              <Clock className="w-4 h-4 text-amber-500" />
            </div>
            <div>
              <p className="text-xs text-slate-400">Scheduled</p>
              <p className="text-lg font-semibold text-slate-900">{counts.scheduled}</p>
            </div>
          </div>
          <div className="bg-white rounded-xl border border-slate-100 shadow-card px-5 py-4 flex items-center gap-3">
            <div className="w-9 h-9 rounded-lg bg-emerald-50 flex items-center justify-center shrink-0">
              <CheckCircle2 className="w-4 h-4 text-emerald-500" />
            </div>
            <div>
              <p className="text-xs text-slate-400">Sent</p>
              <p className="text-lg font-semibold text-slate-900">{counts.sent}</p>
            </div>
          </div>
        </div>

        <div className="bg-white rounded-xl border border-slate-100 shadow-card">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 px-5 pt-5">
            <div className="flex items-center gap-2.5">
              <div className="flex gap-1 bg-slate-100 rounded-lg p-1 w-fit">
                <button
                  onClick={() => setTab("scheduled")}
                  aria-pressed={tab === "scheduled"}
                  className={`px-3.5 py-1.5 rounded-md text-sm font-medium transition ${
                    tab === "scheduled" ? "bg-white text-slate-900 shadow-sm" : "text-slate-500 hover:text-slate-700"
                  }`}
                >
                  Scheduled
                </button>
                <button
                  onClick={() => setTab("sent")}
                  aria-pressed={tab === "sent"}
                  className={`px-3.5 py-1.5 rounded-md text-sm font-medium transition ${
                    tab === "sent" ? "bg-white text-slate-900 shadow-sm" : "text-slate-500 hover:text-slate-700"
                  }`}
                >
                  Sent
                </button>
              </div>
              {/* Subtle, local indicator for background refreshes (polling,
                  post-schedule sync) — never replaces the table content. */}
              {refreshing && !loading && (
                <div
                  className="w-3.5 h-3.5 border-2 border-slate-200 border-t-brand-400 rounded-full animate-spin shrink-0"
                  title="Syncing..."
                />
              )}
            </div>

            <div className="relative w-full sm:w-72">
              <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
              <input
                placeholder="Search subject, body, recipient..."
                className="w-full rounded-lg border border-slate-200 bg-slate-50 pl-9 pr-3 py-2 text-sm placeholder:text-slate-400 focus:bg-white focus:border-brand-400 focus:ring-4 focus:ring-brand-50 transition"
                value={search}
                onChange={(e) => handleSearchChange(e.target.value)}
              />
              {searching && (
                <div className="absolute right-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 border-2 border-slate-300 border-t-brand-500 rounded-full animate-spin" />
              )}
            </div>
          </div>

          <div className="p-5">
            <EmailTable rows={rows} loading={loading} mode={tab} />
          </div>
        </div>
      </main>

      <ComposeModal open={composeOpen} onClose={() => setComposeOpen(false)} onScheduled={handleScheduled} />
    </div>
  );
}
