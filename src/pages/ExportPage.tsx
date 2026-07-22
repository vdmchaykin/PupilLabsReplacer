import { useCallback, useEffect, useMemo, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { Activity, AlertCircle, ArrowRight, Check, Download, FolderOpen, Loader2, Package } from "lucide-react";
import { api } from "@/lib/api";
import { confirmDialog } from "@/components/ConfirmDialog";
import { formatDuration, formatDate } from "@/lib/utils";
import type { NavPage, Project, RecordingMeta } from "@/types";

interface ExportFile {
  name: string;
  section: string;
  mergeable: boolean;
  available: boolean;
  reason: string | null;   // why it can never merge for this source
  todo: string | null;     // the pipeline step still to run
  missing: { id: string; name: string }[];
}

interface Manifest {
  is_project: boolean;
  n_recordings: number;
  files: ExportFile[];
}

// The page that produces each section's files, so an unavailable file can link
// to where the user can make it. Keys mirror ExportSpec.section in the backend.
const SECTION_PAGE: Record<string, NavPage> = {
  Events: "events",
  Gaze: "gaze",
  Heatmap: "heatmap",
};

type Source =
  | { kind: "recording"; id: string; label: string }
  | { kind: "project"; id: string; label: string };

function sourceQuery(s: Source): string {
  return s.kind === "recording" ? `recording_id=${s.id}` : `project_id=${s.id}`;
}

function sourceBody(s: Source) {
  return s.kind === "recording" ? { recording_id: s.id } : { project_id: s.id };
}

interface SaveResult {
  dest: string;
  written: string[];
}

/**
 * Ask for a destination folder and have the backend write the CSVs into it.
 *
 * The app runs in a Tauri webview, which has no browser download manager — an
 * <a href> to the API silently does nothing — so downloads go through the OS
 * folder dialog and the backend writes the files itself.
 *
 * `names` omitted means "every available file", which lands in its own subfolder
 * named after the source. Returns null if the user cancelled the dialog or
 * declined to overwrite.
 */
async function saveExport(source: Source, names?: string[]): Promise<SaveResult | null> {
  const dest = await open({ directory: true, multiple: false, title: "Choose a folder to export into" });
  if (typeof dest !== "string") return null;  // cancelled

  const body = {
    dest,
    ...sourceBody(source),
    ...(names ? { names } : { create_folder: true }),
  };
  try {
    return await api.post<SaveResult>("/api/export/save", body);
  } catch (e) {
    // The backend refuses to clobber existing files until we say so.
    const conflicts = parseConflicts(e);
    if (!conflicts) throw e;

    const ok = await confirmDialog({
      title: "Overwrite existing files?",
      message: `${conflicts.join(", ")} already exist in that folder. Replace them?`,
      confirmLabel: "Overwrite",
    });
    if (!ok) return null;
    return await api.post<SaveResult>("/api/export/save", { ...body, overwrite: true });
  }
}

/** Pull the filename list out of the backend's 409 conflict payload. */
function parseConflicts(e: unknown): string[] | null {
  if (!(e instanceof Error)) return null;
  try {
    const detail = JSON.parse(e.message);
    return Array.isArray(detail?.conflicts) ? detail.conflicts : null;
  } catch {
    return null;
  }
}

export function ExportPage({ onNavigate }: { onNavigate?: (page: NavPage, recording: RecordingMeta) => void }) {
  const [recordings, setRecordings] = useState<RecordingMeta[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [source, setSource] = useState<Source | null>(null);
  const [manifest, setManifest] = useState<Manifest | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);   // file name, or "__all__"
  const [saved, setSaved] = useState<SaveResult | null>(null);

  useEffect(() => {
    Promise.all([
      api.get<RecordingMeta[]>("/api/recordings").catch(() => [] as RecordingMeta[]),
      api.get<Project[]>("/api/projects").catch(() => [] as Project[]),
    ])
      .then(([recs, projs]) => { setRecordings(recs); setProjects(projs); })
      .finally(() => setLoading(false));
  }, []);

  const loadManifest = useCallback(async (s: Source) => {
    setManifest(null);
    setError(null);
    try {
      setManifest(await api.get<Manifest>(`/api/export/manifest?${sourceQuery(s)}`));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load export status");
    }
  }, []);

  const select = (s: Source) => { setSource(s); setSaved(null); loadManifest(s); };

  const handleSave = async (names?: string[]) => {
    if (!source) return;
    setBusy(names?.[0] ?? "__all__");
    setError(null);
    setSaved(null);
    try {
      const res = await saveExport(source, names);
      if (res) setSaved(res);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Export failed");
    } finally {
      setBusy(null);
    }
  };

  const readyCount = manifest?.files.filter(f => f.available).length ?? 0;
  const sections = useMemo(() => {
    if (!manifest) return [];
    const order: string[] = [];
    const by = new Map<string, ExportFile[]>();
    for (const f of manifest.files) {
      if (!by.has(f.section)) { by.set(f.section, []); order.push(f.section); }
      by.get(f.section)!.push(f);
    }
    return order.map(name => ({ name, files: by.get(name)! }));
  }, [manifest]);

  return (
    <div className="flex h-full">
      {/* Source picker */}
      <div className="w-72 border-r border-zinc-800 flex flex-col shrink-0 overflow-y-auto">
        {loading ? (
          <p className="text-zinc-500 text-xs p-4">Loading…</p>
        ) : (
          <>
            <p className="px-4 pt-3 pb-1 text-[10px] uppercase tracking-wider text-zinc-600">
              Projects
            </p>
            {projects.length === 0 ? (
              <p className="px-4 pb-2 text-[11px] text-zinc-600">No projects yet</p>
            ) : projects.map(p => (
              <SourceRow
                key={p.id}
                Icon={FolderOpen}
                title={p.name}
                subtitle={`${p.recording_count} recording${p.recording_count === 1 ? "" : "s"}`}
                active={source?.kind === "project" && source.id === p.id}
                onClick={() => select({ kind: "project", id: p.id, label: p.name })}
              />
            ))}

            <p className="px-4 pt-3 pb-1 text-[10px] uppercase tracking-wider text-zinc-600">
              Recordings
            </p>
            {recordings.length === 0 ? (
              <p className="px-4 pb-2 text-[11px] text-zinc-600">No recordings yet</p>
            ) : recordings.map(r => (
              <SourceRow
                key={r.id}
                Icon={Activity}
                title={r.name}
                subtitle={`${r.wearer_name} · ${formatDuration(r.duration_sec)} · ${formatDate(r.start_time)}`}
                active={source?.kind === "recording" && source.id === r.id}
                onClick={() => select({ kind: "recording", id: r.id, label: r.name })}
              />
            ))}
          </>
        )}
      </div>

      {/* Files */}
      {!source ? (
        <div className="flex-1 flex items-center justify-center text-zinc-600">
          <div className="text-center">
            <Package className="w-10 h-10 mb-3 mx-auto opacity-20" />
            <p className="text-sm">Select a recording or project to export</p>
          </div>
        </div>
      ) : (
        <div className="flex-1 min-w-0 overflow-y-auto">
          <div className="max-w-2xl p-6">
            <div className="flex items-start gap-4 mb-5">
              <div className="min-w-0 flex-1">
                <h2 className="text-lg font-semibold text-white truncate">{source.label}</h2>
                <p className="text-xs text-zinc-500 mt-0.5">
                  {manifest
                    ? manifest.is_project
                      ? `Project · ${manifest.n_recordings} recordings merged into one CSV per file`
                      : "Single recording"
                    : "Loading…"}
                </p>
              </div>

              <button
                onClick={() => handleSave()}
                disabled={!manifest || readyCount === 0 || busy !== null}
                className="flex items-center gap-1.5 px-3 py-2 rounded-md text-xs font-medium shrink-0
                           bg-indigo-600 hover:bg-indigo-500 text-white
                           disabled:bg-zinc-800 disabled:text-zinc-500 disabled:cursor-not-allowed
                           transition-colors cursor-pointer"
              >
                {busy === "__all__"
                  ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  : <Package className="w-3.5 h-3.5" />}
                Download all ({readyCount})
              </button>
            </div>

            {saved && (
              <div className="flex items-start gap-2 text-xs text-emerald-400 mb-4">
                <Check className="w-3.5 h-3.5 shrink-0 mt-px" />
                <span>
                  Saved {saved.written.length} file{saved.written.length === 1 ? "" : "s"} to{" "}
                  <span className="font-mono text-[11px]">{saved.dest}</span>
                </span>
              </div>
            )}

            {error && (
              <div className="flex items-start gap-2 text-xs text-red-400 mb-4">
                <AlertCircle className="w-3.5 h-3.5 shrink-0 mt-px" />
                <span>{error}</span>
              </div>
            )}

            {sections.map(sec => (
              <div key={sec.name} className="mb-5">
                <p className="text-[10px] uppercase tracking-wider text-zinc-600 mb-2">{sec.name}</p>
                <div className="flex flex-col gap-1.5">
                  {sec.files.map(f => (
                    <FileRow
                      key={f.name}
                      file={f}
                      busy={busy === f.name}
                      disabled={busy !== null}
                      onSave={() => handleSave([f.name])}
                      isProject={manifest?.is_project ?? false}
                      onGoTo={onNavigate && (recId => {
                        const page = SECTION_PAGE[f.section];
                        const rec = recordings.find(r => r.id === recId);
                        if (page && rec) onNavigate(page, rec);
                      })}
                    />
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function SourceRow({
  Icon, title, subtitle, active, onClick,
}: {
  Icon: typeof Activity;
  title: string;
  subtitle: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={`w-full flex items-center gap-3 px-4 py-2.5 text-left border-b border-zinc-800/50
        transition-colors cursor-pointer ${active ? "bg-zinc-800" : "hover:bg-zinc-900"}`}
    >
      <Icon className="w-4 h-4 shrink-0 text-indigo-400" />
      <div className="flex-1 min-w-0">
        <p className="text-sm text-white truncate">{title}</p>
        <p className="text-[11px] text-zinc-500 truncate">{subtitle}</p>
      </div>
    </button>
  );
}

function FileRow({
  file, busy, disabled, onSave, isProject, onGoTo,
}: {
  file: ExportFile;
  busy: boolean;
  disabled: boolean;
  onSave: () => void;
  isProject: boolean;
  onGoTo?: (recordingId: string) => void;
}) {
  // Where to send the user to produce this file. `missing` is empty when the file
  // can never merge, and that has no step to link to.
  const canGoTo = onGoTo && SECTION_PAGE[file.section] && file.missing.length > 0;

  return (
    <div className="rounded-md border border-zinc-800 bg-zinc-900/40 px-3 py-2">
      <div className="flex items-center gap-2">
        <span
          className={`w-2 h-2 rounded-full shrink-0 ${
            file.available ? "bg-emerald-400" : "border border-zinc-600"
          }`}
        />
        <span className={`text-xs font-mono truncate flex-1 ${
          file.available ? "text-zinc-200" : "text-zinc-600"
        }`}>
          {file.name}
        </span>

        {file.available ? (
          <button
            onClick={onSave}
            disabled={disabled}
            className="flex items-center gap-1 px-2 py-1 rounded text-[11px] text-zinc-400
                       hover:text-white hover:bg-zinc-800 disabled:opacity-40
                       disabled:cursor-not-allowed transition-colors cursor-pointer shrink-0"
          >
            {busy ? <Loader2 className="w-3 h-3 animate-spin" /> : <Download className="w-3 h-3" />}
            CSV
          </button>
        ) : (
          <span className="text-[10px] text-zinc-600 shrink-0 px-2">Not available</span>
        )}
      </div>

      {/* Why it isn't available, and what to do about it */}
      {!file.available && (file.reason || file.todo) && (
        <div className="mt-1.5 pl-4 flex flex-col gap-0.5">
          <p className="text-[11px] text-amber-500/90">{file.reason ?? file.todo}</p>

          {/* One recording to fix — link straight to its page */}
          {canGoTo && !isProject && (
            <button
              onClick={() => onGoTo!(file.missing[0].id)}
              className="flex items-center gap-1 self-start text-[11px] text-indigo-400
                         hover:text-indigo-300 hover:underline cursor-pointer transition-colors"
            >
              Go to {file.section}
              <ArrowRight className="w-3 h-3" />
            </button>
          )}

          {/* Several to fix — link each recording that still needs the step */}
          {file.missing.length > 0 && isProject && (
            <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
              <span className="text-[10px] text-zinc-600">Missing for:</span>
              {file.missing.map(m => canGoTo ? (
                <button
                  key={m.id}
                  onClick={() => onGoTo!(m.id)}
                  className="flex items-center gap-0.5 text-[10px] text-indigo-400
                             hover:text-indigo-300 hover:underline cursor-pointer transition-colors"
                >
                  {m.name}
                  <ArrowRight className="w-2.5 h-2.5" />
                </button>
              ) : (
                <span key={m.id} className="text-[10px] text-zinc-600">{m.name}</span>
              ))}
            </div>
          )}
        </div>
      )}

      {file.available && file.mergeable === false && (
        <p className="mt-1 pl-4 text-[10px] text-zinc-600 flex items-center gap-1">
          <Check className="w-2.5 h-2.5" /> single recording only
        </p>
      )}
    </div>
  );
}
