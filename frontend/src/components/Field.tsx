import { InputHTMLAttributes, TextareaHTMLAttributes, ReactNode } from "react";

const fieldClass =
  "w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 placeholder:text-slate-400 shadow-sm transition focus:border-brand-400 focus:ring-4 focus:ring-brand-50 disabled:bg-slate-50 disabled:text-slate-400";

export function Label({ children, hint }: { children: ReactNode; hint?: string }) {
  return (
    <div className="flex items-baseline justify-between mb-1.5">
      <label className="block text-xs font-medium text-slate-600 uppercase tracking-wide">{children}</label>
      {hint && <span className="text-xs text-slate-400">{hint}</span>}
    </div>
  );
}

export function Input(props: InputHTMLAttributes<HTMLInputElement>) {
  return <input className={fieldClass} {...props} />;
}

export function Textarea(props: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea className={fieldClass} {...props} />;
}
