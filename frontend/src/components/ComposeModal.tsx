import { useRef, useState } from "react";
import { UploadCloud, FileText, X, Mail, Users } from "lucide-react";
import { Modal } from "./Modal";
import { Button } from "./Button";
import { Label, Input, Textarea } from "./Field";
import { api } from "../lib/api";
import { useToast } from "./Toast";

type RecipientMode = "single" | "csv";

export function ComposeModal({
  open,
  onClose,
  onScheduled,
}: {
  open: boolean;
  onClose: () => void;
  onScheduled: () => void;
}) {
  const toast = useToast();
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [recipientMode, setRecipientMode] = useState<RecipientMode>("single");
  const [recipient, setRecipient] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [dragActive, setDragActive] = useState(false);
  const [detectedCount, setDetectedCount] = useState<number | null>(null);
  const [startTime, setStartTime] = useState("");
  const [delaySeconds, setDelaySeconds] = useState(5);
  const [hourlyLimit, setHourlyLimit] = useState(200);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function reset() {
    setSubject("");
    setBody("");
    setRecipientMode("single");
    setRecipient("");
    setFile(null);
    setDetectedCount(null);
    setStartTime("");
    setDelaySeconds(5);
    setHourlyLimit(200);
    setError(null);
  }

  async function handleFile(f: File | null) {
    setFile(f);
    if (!f) {
      setDetectedCount(null);
      return;
    }
    // Quick client-side estimate for instant feedback; the backend
    // re-parses the file itself and is the authoritative source.
    const text = await f.text();
    const matches = text.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g);
    setDetectedCount(matches ? new Set(matches.map((m) => m.toLowerCase())).size : 0);
  }

  function onDrop(e: React.DragEvent) {
    e.preventDefault();
    setDragActive(false);
    const dropped = e.dataTransfer.files?.[0];
    if (dropped) handleFile(dropped);
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!subject || !body || !startTime) {
      setError("Subject, body and start time are required.");
      return;
    }
    if (recipientMode === "csv" && !file) {
      setError("Upload a CSV or text file of leads, or switch to a single recipient.");
      return;
    }
    if (recipientMode === "single" && !recipient) {
      setError("Enter a recipient email address.");
      return;
    }

    setSubmitting(true);
    try {
      const form = new FormData();
      form.append("subject", subject);
      form.append("body", body);
      form.append("startTime", new Date(startTime).toISOString());
      form.append("delayBetweenEmailsMs", String(delaySeconds * 1000));
      form.append("hourlyLimit", String(hourlyLimit));
      if (recipientMode === "csv" && file) form.append("leads", file);
      else form.append("recipient", recipient);

      const result = await api.scheduleEmails(form);
      onScheduled();
      onClose();
      reset();
      toast.show(
        "success",
        `Scheduled ${result.scheduledCount} email${result.scheduledCount === 1 ? "" : "s"}.`
      );
    } catch (err: any) {
      const message = err.message || "Failed to schedule emails.";
      setError(message);
      toast.show("error", message);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Compose new email"
      subtitle="Schedule a single email or a batch from a lead list."
      maxWidth="max-w-xl"
    >
      <form onSubmit={handleSubmit} className="space-y-7">
        <section className="space-y-4">
          <h3 className="text-xs font-semibold text-slate-400 uppercase tracking-wide">Message</h3>
          <div>
            <Label>Subject</Label>
            <Input value={subject} onChange={(e) => setSubject(e.target.value)} placeholder="Quick question about..." />
          </div>
          <div>
            <Label>Body</Label>
            <Textarea
              className="h-28 resize-none"
              value={body}
              onChange={(e) => setBody(e.target.value)}
              placeholder="Write your message..."
            />
          </div>
        </section>

        <section className="border-t border-slate-100 pt-5 space-y-3">
          <h3 className="text-xs font-semibold text-slate-400 uppercase tracking-wide">Recipients</h3>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => setRecipientMode("single")}
              className={`flex-1 flex items-center justify-center gap-1.5 rounded-lg border px-3 py-2 text-sm font-medium transition ${
                recipientMode === "single"
                  ? "border-brand-300 bg-brand-50 text-brand-700"
                  : "border-slate-200 text-slate-500 hover:bg-slate-50"
              }`}
            >
              <Mail className="w-4 h-4" /> Single recipient
            </button>
            <button
              type="button"
              onClick={() => setRecipientMode("csv")}
              className={`flex-1 flex items-center justify-center gap-1.5 rounded-lg border px-3 py-2 text-sm font-medium transition ${
                recipientMode === "csv"
                  ? "border-brand-300 bg-brand-50 text-brand-700"
                  : "border-slate-200 text-slate-500 hover:bg-slate-50"
              }`}
            >
              <Users className="w-4 h-4" /> Upload leads
            </button>
          </div>

          {recipientMode === "single" ? (
            <Input
              type="email"
              placeholder="someone@example.com"
              value={recipient}
              onChange={(e) => setRecipient(e.target.value)}
            />
          ) : file ? (
            <div className="flex items-center justify-between rounded-lg border border-slate-200 bg-slate-50 px-3 py-2.5">
              <div className="flex items-center gap-2 min-w-0">
                <FileText className="w-4 h-4 text-brand-500 shrink-0" />
                <span className="text-sm text-slate-700 truncate">{file.name}</span>
                {detectedCount !== null && (
                  <span className="text-xs bg-brand-100 text-brand-700 px-1.5 py-0.5 rounded-full font-medium shrink-0">
                    {detectedCount} email{detectedCount === 1 ? "" : "s"}
                  </span>
                )}
              </div>
              <button
                type="button"
                onClick={() => handleFile(null)}
                className="text-slate-400 hover:text-slate-600 shrink-0"
                aria-label="Remove file"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
          ) : (
            <div
              onDragOver={(e) => {
                e.preventDefault();
                setDragActive(true);
              }}
              onDragLeave={() => setDragActive(false)}
              onDrop={onDrop}
              onClick={() => fileInputRef.current?.click()}
              className={`flex flex-col items-center justify-center gap-1.5 rounded-lg border-2 border-dashed px-4 py-6 text-center cursor-pointer transition ${
                dragActive ? "border-brand-400 bg-brand-50" : "border-slate-200 hover:border-slate-300 hover:bg-slate-50"
              }`}
            >
              <UploadCloud className={`w-6 h-6 ${dragActive ? "text-brand-500" : "text-slate-300"}`} />
              <p className="text-sm text-slate-600">
                <span className="font-medium text-brand-600">Click to upload</span> or drag and drop
              </p>
              <p className="text-xs text-slate-400">CSV or TXT — any column containing email addresses</p>
              <input
                ref={fileInputRef}
                type="file"
                accept=".csv,.txt"
                className="hidden"
                onChange={(e) => handleFile(e.target.files?.[0] || null)}
              />
            </div>
          )}
        </section>

        <section className="border-t border-slate-100 pt-5 space-y-3">
          <h3 className="text-xs font-semibold text-slate-400 uppercase tracking-wide">Timing &amp; rate limit</h3>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-x-4 gap-y-5">
            <div className="flex flex-col gap-1.5 min-w-0">
              <Label>Start time</Label>
              <Input type="datetime-local" value={startTime} onChange={(e) => setStartTime(e.target.value)} />
              <span className="text-xs text-slate-400">Your local time</span>
            </div>
            <div className="flex flex-col gap-1.5 min-w-0">
              <Label>Delay</Label>
              <Input
                type="number"
                min={0}
                value={delaySeconds}
                onChange={(e) => setDelaySeconds(parseInt(e.target.value, 10) || 0)}
              />
              <span className="text-xs text-slate-400">Seconds between sends</span>
            </div>
            <div className="flex flex-col gap-1.5 min-w-0">
              <Label>Limit</Label>
              <Input
                type="number"
                min={1}
                value={hourlyLimit}
                onChange={(e) => setHourlyLimit(parseInt(e.target.value, 10) || 1)}
              />
              <span className="text-xs text-slate-400">Emails per hour</span>
            </div>
          </div>
          <p className="text-xs text-slate-400 leading-relaxed">
            The hard cap enforced by the server comes from its <code className="text-slate-500">MAX_EMAILS_PER_HOUR_PER_SENDER</code> setting.
            The value above just spaces out this batch to help you stay under it.
          </p>
        </section>

        {error && (
          <div className="rounded-lg bg-red-50 border border-red-100 text-red-700 text-sm px-3 py-2">{error}</div>
        )}

        <div className="flex justify-end gap-2 pt-1">
          <Button type="button" variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" loading={submitting}>
            {submitting ? "Scheduling..." : "Schedule"}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
