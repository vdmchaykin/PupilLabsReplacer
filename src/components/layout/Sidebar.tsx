import { FolderOpen, Layers, Download, Eye } from "lucide-react";
import type { Page } from "@/types";

interface SidebarProps {
  current: Page;
  onChange: (page: Page) => void;
}

const navItems: { id: Page; label: string; Icon: React.ElementType }[] = [
  { id: "recordings", label: "Recordings", Icon: FolderOpen },
  { id: "projects", label: "Projects", Icon: Layers },
  { id: "export", label: "Export", Icon: Download },
];

export function Sidebar({ current, onChange }: SidebarProps) {
  return (
    <aside className="flex flex-col w-16 bg-zinc-900 border-r border-zinc-800 h-full">
      <div className="flex items-center justify-center h-14 border-b border-zinc-800">
        <Eye className="w-6 h-6 text-indigo-400" />
      </div>

      <nav className="flex flex-col gap-1 p-2 flex-1">
        {navItems.map(({ id, label, Icon }) => (
          <button
            key={id}
            onClick={() => onChange(id)}
            title={label}
            className={`
              flex flex-col items-center justify-center gap-1 rounded-lg p-2 text-xs
              transition-colors cursor-pointer
              ${current === id
                ? "bg-indigo-600 text-white"
                : "text-zinc-400 hover:bg-zinc-800 hover:text-white"
              }
            `}
          >
            <Icon className="w-5 h-5" />
            <span className="text-[10px] leading-none">{label}</span>
          </button>
        ))}
      </nav>

      <div className="p-2 border-t border-zinc-800 text-center text-[10px] text-zinc-600">
        v0.1
      </div>
    </aside>
  );
}
