import { useEffect, useState } from "react";
import { api } from "@/lib/api";

const PAGE_TITLES: Record<string, string> = {
  recordings: "Recordings",
  projects: "Projects",
  gaze: "Gaze Analysis",
  export: "Export",
};

interface TopBarProps {
  current: string;
}

export function TopBar({ current }: TopBarProps) {
  const [online, setOnline] = useState(false);

  useEffect(() => {
    const check = () => {
      api.get("/api/health")
        .then(() => setOnline(true))
        .catch(() => setOnline(false));
    };
    check();
    const interval = setInterval(check, 3000);
    return () => clearInterval(interval);
  }, []);

  return (
    <header className="flex items-center justify-between h-14 px-6 border-b border-zinc-800 bg-zinc-950">
      <h1 className="text-sm font-semibold text-white tracking-wide">
        {PAGE_TITLES[current] ?? current}
      </h1>
      <div className="flex items-center gap-2 text-xs">
        <span className={`w-2 h-2 rounded-full ${online ? "bg-emerald-400" : "bg-red-500"}`} />
        <span className="text-zinc-400">{online ? "Backend online" : "Backend offline"}</span>
      </div>
    </header>
  );
}
