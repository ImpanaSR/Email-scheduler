import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Send, Zap, ShieldCheck, BarChart3 } from "lucide-react";
import { api } from "../lib/api";
import { Button } from "../components/Button";

export default function LoginPage() {
  const navigate = useNavigate();
  const [checking, setChecking] = useState(true);

  useEffect(() => {
    api
      .me()
      .then(() => navigate("/dashboard"))
      .catch(() => setChecking(false));
  }, [navigate]);

  if (checking) return null;

  return (
    <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-slate-50 via-white to-brand-50 px-4">
      <div className="w-full max-w-sm">
        <div className="bg-white shadow-xl shadow-slate-200/60 rounded-2xl border border-slate-100 p-8 text-center">
          <div className="w-12 h-12 rounded-xl bg-brand-600 flex items-center justify-center mx-auto mb-5 shadow-lg shadow-brand-600/20">
            <Send className="w-5 h-5 text-white" />
          </div>
          <h1 className="text-xl font-bold text-slate-900">ReachInbox Scheduler</h1>
          <p className="text-slate-500 text-sm mt-1.5 mb-8">Schedule, throttle, and track cold email sends.</p>

          <Button className="w-full" onClick={() => (window.location.href = api.googleLoginUrl())}>
            <svg className="w-4 h-4" viewBox="0 0 24 24">
              <path
                fill="#fff"
                d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"
              />
              <path
                fill="#fff"
                d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
              />
              <path
                fill="#fff"
                d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"
              />
              <path
                fill="#fff"
                d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"
              />
            </svg>
            Sign in with Google
          </Button>
        </div>

        <div className="grid grid-cols-3 gap-3 mt-6 text-center">
          {[
            { icon: Zap, label: "BullMQ scheduling" },
            { icon: ShieldCheck, label: "Rate-limit safe" },
            { icon: BarChart3, label: "Live tracking" },
          ].map(({ icon: Icon, label }) => (
            <div key={label} className="flex flex-col items-center gap-1.5 text-slate-400">
              <Icon className="w-4 h-4" />
              <span className="text-[11px] leading-tight">{label}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
