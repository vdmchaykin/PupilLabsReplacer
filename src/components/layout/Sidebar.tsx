import { FolderOpen, Layers, Download, Eye, ScanEye, CalendarClock } from "lucide-react";
import type { Page } from "@/types";

interface SidebarProps {
  current: Page;
  onChange: (page: Page) => void;
}

const topItems: { id: Page; label: string; Icon: React.ElementType }[] = [
  { id: "recordings", label: "Recordings", Icon: FolderOpen },
  { id: "projects", label: "Projects", Icon: Layers },
  { id: "gaze", label: "Gaze", Icon: ScanEye },
  { id: "events", label: "Events", Icon: CalendarClock },
];

const exportItem = { id: "export" as Page, label: "Export", Icon: Download };

function NavButton({
  id, label, Icon, current, onChange,
}: { id: Page; label: string; Icon: React.ElementType; current: Page; onChange: (p: Page) => void }) {
  return (
    <button
      onClick={() => onChange(id)}
      title={label}
      className={`
        flex flex-col items-center justify-center gap-1 rounded-lg px-2 py-[5px] text-xs
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
  );
}

export function Sidebar({ current, onChange }: SidebarProps) {
  return (
    <aside className="flex flex-col w-16 bg-zinc-900 border-r border-zinc-800 h-full">
      <div className="flex items-center justify-center h-14 border-b border-zinc-800">
        <Eye className="w-6 h-6 text-indigo-400" />
      </div>

      <nav className="flex flex-col gap-3 p-2 flex-1">
        {topItems.map(({ id, label, Icon }) => (
          <NavButton key={id} id={id} label={label} Icon={Icon} current={current} onChange={onChange} />
        ))}
        <div className="mt-auto">
          <NavButton {...exportItem} current={current} onChange={onChange} />
        </div>
      </nav>

      <div className="p-2 border-t border-zinc-800 text-center text-[10px] text-zinc-600">
        v0.1
      </div>
    </aside>
  );
}
