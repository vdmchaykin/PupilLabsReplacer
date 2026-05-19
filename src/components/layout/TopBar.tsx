import { useEffect, useState } from "react";
import { Sun, Moon } from "lucide-react";
import { api } from "@/lib/api";
import { useTheme } from "@/lib/theme";

const PAGE_TITLES: Record<string, string> = {
  recordings: "Recordings",
  projects: "Projects",
  gaze: "Gaze Estimation",
  export: "Export",
  events: "Events Annotation",
  aoi: "Area of Interest Annotation",
};

interface TopBarProps {
  current: string;
}

export function TopBar({ current }: TopBarProps) {
  const [online, setOnline] = useState(false);
  const { theme, toggle } = useTheme();

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
      <div className="flex items-center gap-3 text-xs">
        <div className="flex items-center gap-2">
          <span className={`w-2 h-2 rounded-full ${online ? "bg-emerald-400" : "bg-red-500"}`} />
          <span className="text-zinc-400">{online ? "Backend online" : "Backend offline"}</span>
        </div>
        <button
          onClick={toggle}
          title={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
          className="p-1.5 rounded-lg text-zinc-400 hover:text-white hover:bg-zinc-800 transition-colors cursor-pointer"
        >
          {theme === "dark" ? <Sun className="w-4 h-4" /> : <Moon className="w-4 h-4" />}
        </button>
      </div>
    </header>
  );
}
