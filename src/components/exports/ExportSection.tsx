import type { ReactNode } from "react";
import type { LucideIcon } from "lucide-react";

export interface ExportFile {
  name: string;
  ready: boolean;
}

/**
 * One export group in the right-hand sidebar: a titled card listing the files it
 * produces, each with a readiness dot, above whatever action/status the panel
 * supplies as children.
 *
 * The files are written into the recording folder rather than downloaded here —
 * the dot is the signal that they exist and are up to date.
 */
export function ExportSection({
  title, Icon, files, children,
}: {
  title: string;
  Icon: LucideIcon;
  files: ExportFile[];
  children?: ReactNode;
}) {
  return (
    <section className="rounded-lg border border-zinc-800 bg-zinc-900/40 overflow-hidden">
      <header className="flex items-center gap-1.5 px-2.5 py-2 border-b border-zinc-800/60">
        <Icon className="w-3 h-3 text-zinc-500 shrink-0" />
        <h3 className="text-[11px] font-medium text-zinc-300 truncate">{title}</h3>
      </header>

      <div className="flex flex-col gap-2 p-2.5">
        <ul className="flex flex-col gap-1">
          {files.map(f => (
            <li key={f.name} className="flex items-center gap-1.5" title={f.ready ? "Ready" : "Not generated yet"}>
              <span
                className={`w-2 h-2 rounded-full shrink-0 ${
                  f.ready ? "bg-emerald-400" : "border border-zinc-600"
                }`}
              />
              <span className={`text-[10px] font-mono truncate ${f.ready ? "text-zinc-300" : "text-zinc-600"}`}>
                {f.name}
              </span>
            </li>
          ))}
        </ul>

        {children}
      </div>
    </section>
  );
}
