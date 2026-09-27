import { Inbox, ExternalLink, AlertCircle } from "lucide-react";
import { EmailRow } from "../lib/api";
import { StatusBadge } from "./StatusBadge";

function SkeletonRow() {
  return (
    <tr className="animate-pulse">
      <td className="py-3 pr-4"><div className="h-3.5 bg-slate-100 rounded w-32" /></td>
      <td className="py-3 pr-4"><div className="h-3.5 bg-slate-100 rounded w-40" /></td>
      <td className="py-3 pr-4"><div className="h-3.5 bg-slate-100 rounded w-28" /></td>
      <td className="py-3 pr-4"><div className="h-5 bg-slate-100 rounded-full w-20" /></td>
    </tr>
  );
}

export function EmailTable({
  rows,
  loading,
  mode,
}: {
  rows: EmailRow[];
  loading: boolean;
  mode: "scheduled" | "sent" | "failed";
}) {
  // Only show the skeleton when there's truly nothing to display yet.
  // Once rows exist, a background refresh (polling, etc.) must never blank
  // the table back to a skeleton — that's what caused the whole dashboard
  // to "blink" on every poll/action.
  if (loading && rows.length === 0) {
    return (
      <table className="w-full text-sm">
        <tbody>
          {Array.from({ length: 4 }).map((_, i) => (
            <SkeletonRow key={i} />
          ))}
        </tbody>
      </table>
    );
  }

  if (rows.length === 0) {
    return (
      <div className="py-16 flex flex-col items-center justify-center text-center">
        <div className="w-12 h-12 rounded-full bg-slate-50 flex items-center justify-center mb-3">
          <Inbox className="w-5 h-5 text-slate-300" />
        </div>
        <p className="text-sm font-medium text-slate-500">
          {mode === "scheduled" ? "No scheduled emails yet" : mode === "sent" ? "No emails have been sent yet" : "No failed emails"}
        </p>
        <p className="text-xs text-slate-400 mt-1">
          {mode === "scheduled"
            ? "Compose a new email to get started."
            : mode === "sent"
              ? "Sent emails will show up here."
              : "Emails that exhaust their retries will show up here."}
        </p>
      </div>
    );
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm min-w-[640px]">
        <thead>
          <tr className="text-left border-b border-slate-100">
            <th className="py-2.5 pr-4 font-medium text-xs text-slate-400 uppercase tracking-wide">Recipient</th>
            <th className="py-2.5 pr-4 font-medium text-xs text-slate-400 uppercase tracking-wide">Subject</th>
            <th className="py-2.5 pr-4 font-medium text-xs text-slate-400 uppercase tracking-wide">
              {mode === "scheduled" || mode === "failed" ? "Scheduled time" : "Sent time"}
            </th>
            <th className="py-2.5 pr-4 font-medium text-xs text-slate-400 uppercase tracking-wide">Status</th>
            {mode === "sent" && (
              <th className="py-2.5 pr-4 font-medium text-xs text-slate-400 uppercase tracking-wide">Preview</th>
            )}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.id} className="border-b border-slate-50 last:border-0 hover:bg-slate-50/70 transition-colors">
              <td className="py-3 pr-4 text-slate-700">{row.recipient}</td>
              <td className="py-3 pr-4 max-w-xs truncate text-slate-600" title={row.subject}>
                {row.subject}
              </td>
              <td className="py-3 pr-4 whitespace-nowrap text-slate-500">
                {new Date(mode === "sent" ? row.sent_time || row.scheduled_time : row.scheduled_time).toLocaleString(
                  undefined,
                  { dateStyle: "medium", timeStyle: "short" }
                )}
              </td>
              <td className="py-3 pr-4">
                <div className="flex flex-col gap-1">
                  <StatusBadge status={row.status} />
                  {row.status === "failed" && row.error && (
                    <span className="inline-flex items-center gap-1 text-xs text-red-500 max-w-[220px] truncate" title={row.error}>
                      <AlertCircle className="w-3 h-3 shrink-0" />
                      {row.error}
                    </span>
                  )}
                </div>
              </td>
              {mode === "sent" && (
                <td className="py-3 pr-4">
                  {row.preview_url ? (
                    <a
                      href={row.preview_url}
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex items-center gap-1 text-brand-600 hover:text-brand-700 font-medium"
                    >
                      View <ExternalLink className="w-3 h-3" />
                    </a>
                  ) : (
                    <span className="text-slate-300">—</span>
                  )}
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
