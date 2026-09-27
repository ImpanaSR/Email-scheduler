import { Clock, Loader2, CheckCircle2, XCircle } from "lucide-react";
import { EmailRow } from "../lib/api";

const CONFIG: Record<EmailRow["status"], { label: string; className: string; icon: JSX.Element }> = {
  scheduled: {
    label: "Scheduled",
    className: "bg-amber-50 text-amber-700 ring-1 ring-inset ring-amber-200",
    icon: <Clock className="w-3 h-3" />,
  },
  processing: {
    label: "Sending",
    className: "bg-blue-50 text-blue-700 ring-1 ring-inset ring-blue-200",
    icon: <Loader2 className="w-3 h-3 animate-spin" />,
  },
  sent: {
    label: "Sent",
    className: "bg-emerald-50 text-emerald-700 ring-1 ring-inset ring-emerald-200",
    icon: <CheckCircle2 className="w-3 h-3" />,
  },
  failed: {
    label: "Failed",
    className: "bg-red-50 text-red-700 ring-1 ring-inset ring-red-200",
    icon: <XCircle className="w-3 h-3" />,
  },
};

export function StatusBadge({ status }: { status: EmailRow["status"] }) {
  const cfg = CONFIG[status] || CONFIG.scheduled;
  return (
    <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium ${cfg.className}`}>
      {cfg.icon}
      {cfg.label}
    </span>
  );
}
