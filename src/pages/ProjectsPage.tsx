import { useEffect, useRef, useState } from "react";
import {
  Plus, Upload, X, Brain, Flag, Target, Trash2, Cpu, Clock,
  User, FolderOpen, ArrowLeft, CalendarClock, ChevronRight, Play,
  LayoutGrid, List,
} from "lucide-react";
import { open } from "@tauri-apps/plugin-dialog";
import { api } from "@/lib/api";
import { formatDuration, formatDate } from "@/lib/utils";
import type { Project, ProjectRef, RecordingMeta } from "@/types";

const API = "http://localhost:8765";

const TILE_COLORS = [
  { icon: "text-indigo-400", bg: "bg-indigo-500/10", border: "border-indigo-500/20", hover: "hover:border-indigo-400/50 hover:bg-indigo-500/15" },
  { icon: "text-violet-400", bg: "bg-violet-500/10", border: "border-violet-500/20", hover: "hover:border-violet-400/50 hover:bg-violet-500/15" },
  { icon: "text-sky-400",    bg: "bg-sky-500/10",    border: "border-sky-500/20",    hover: "hover:border-sky-400/50 hover:bg-sky-500/15" },
  { icon: "text-emerald-400",bg: "bg-emerald-500/10",border: "border-emerald-500/20",hover: "hover:border-emerald-400/50 hover:bg-emerald-500/15" },
  { icon: "text-amber-400",  bg: "bg-amber-500/10",  border: "border-amber-500/20",  hover: "hover:border-amber-400/50 hover:bg-amber-500/15" },
  { icon: "text-rose-400",   bg: "bg-rose-500/10",   border: "border-rose-500/20",   hover: "hover:border-rose-400/50 hover:bg-rose-500/15" },
];

interface ProjectsPageProps {
  onNavigate: (page: "gaze" | "events" | "aoi", recording: RecordingMeta) => void;
  onOpenPlayer: (id: string) => void;
}

export function ProjectsPage({ onNavigate, onOpenPlayer }: ProjectsPageProps) {
  const [projects, setProjects] = useState<Project[]>([]);
  const [allRecs, setAllRecs] = useState<RecordingMeta[]>([]);
  const [recsLayout, setRecsLayout] = useState<"list" | "grid">("list");
  const [view, setView] = useState<"grid" | "project" | "recording">("grid");
  const [openProject, setOpenProject] = useState<Project | null>(null);
  const [projectRecs, setProjectRecs] = useState<RecordingMeta[]>([]);
  const [selectedRec, setSelectedRec] = useState<RecordingMeta | null>(null);
  const [importing, setImporting] = useState(false);
  const [creatingProject, setCreatingProject] = useState(false);
  const [newProjectName, setNewProjectName] = useState("");
  const [error, setError] = useState<string | null>(null);

  const fetchProjects = async () => {
    try {
      const data = await api.get<Project[]>("/api/projects");
      setProjects(data);
    } catch {
      setError("Backend unavailable");
    }
  };

  const fetchAllRecs = async () => {
    try {
      const data = await api.get<RecordingMeta[]>("/api/recordings");
      setAllRecs(data);
    } catch {
      setError("Backend unavailable");
    }
  };

  useEffect(() => { fetchProjects(); fetchAllRecs(); }, []);

  const handleOpenProject = async (project: Project) => {
    setOpenProject(project);
    setSelectedRec(null);
    setView("project");
    try {
      const recs = await api.get<RecordingMeta[]>(`/api/projects/${project.id}/recordings`);
      setProjectRecs(recs);
    } catch {
      setProjectRecs([]);
    }
  };

  const handleBack = () => {
    setView("grid");
    setOpenProject(null);
    setSelectedRec(null);
    setProjectRecs([]);
  };

  const handleImport = async () => {
    const nativePath = await open({
      filters: [{ name: "ZIP Archive", extensions: ["zip"] }],
      title: "Select Native Recording Data zip",
    });
    if (!nativePath) return;
    setImporting(true);
    try {
      const rec = await api.post<RecordingMeta>("/api/recordings/import", { native_zip_path: nativePath });
      if (openProject) {
        await api.post(`/api/projects/${openProject.id}/recordings`, { recording_id: rec.id });
        const recs = await api.get<RecordingMeta[]>(`/api/projects/${openProject.id}/recordings`);
        setProjectRecs(recs);
      }
      await fetchProjects();
      await fetchAllRecs();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Import failed");
    } finally {
      setImporting(false);
    }
  };

  const handleCreateProject = async () => {
    if (!newProjectName.trim()) return;
    try {
      await api.post("/api/projects", { name: newProjectName.trim() });
      setNewProjectName("");
      setCreatingProject(false);
      await fetchProjects();
    } catch {
      setError("Failed to create project");
    }
  };

  const handleDeleteProject = async (id: string) => {
    try {
      await api.delete(`/api/projects/${id}`);
      await fetchProjects();
      await fetchAllRecs();
    } catch {
      setError("Failed to delete project");
    }
  };

  const handleRemoveRecording = async (recId: string) => {
    if (!openProject) return;
    try {
      await api.delete(`/api/projects/${openProject.id}/recordings/${recId}`);
      setProjectRecs((prev) => prev.filter((r) => r.id !== recId));
      if (selectedRec?.id === recId) setSelectedRec(null);
      await fetchProjects();
      await fetchAllRecs();
    } catch {
      setError("Failed to remove recording");
    }
  };

  // Open a recording from the "All Recordings" list (no project context)
  const handleOpenRecording = (rec: RecordingMeta) => {
    setOpenProject(null);
    setSelectedRec(rec);
    setView("recording");
  };

  // Delete a recording from the database entirely
  const handleDeleteRecording = async (recId: string) => {
    try {
      await api.delete(`/api/recordings/${recId}`);
      if (selectedRec?.id === recId) { setSelectedRec(null); setView("grid"); }
      await fetchAllRecs();
      await fetchProjects();
    } catch {
      setError("Failed to delete recording");
    }
  };

  // ── Project grid view ──────────────────────────────────────────────────────
  if (view === "grid") {
    return (
      <div className="flex flex-col h-full">
        {creatingProject && (
          <div className="px-6 py-3 border-b border-zinc-800 flex items-center gap-2">
            <input
              autoFocus
              value={newProjectName}
              onChange={(e) => setNewProjectName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") handleCreateProject();
                if (e.key === "Escape") { setCreatingProject(false); setNewProjectName(""); }
              }}
              placeholder="Project name…"
              className="flex-1 bg-zinc-800 text-white text-sm px-3 py-1.5 rounded outline-none
                         border border-zinc-700 focus:border-indigo-500 placeholder:text-zinc-600"
            />
            <button onClick={handleCreateProject}
              className="text-xs px-3 py-1.5 bg-emerald-700 hover:bg-emerald-600 text-white rounded cursor-pointer">
              Create
            </button>
            <button onClick={() => { setCreatingProject(false); setNewProjectName(""); }}
              className="text-zinc-500 hover:text-zinc-300 cursor-pointer">
              <X className="w-4 h-4" />
            </button>
          </div>
        )}

        {error && (
          <div className="mx-6 mt-3 px-3 py-2 bg-red-950 border border-red-800 rounded text-red-300 text-xs">
            {error}
          </div>
        )}

        {/* Tile grid */}
        <div className="flex-1 overflow-auto p-6">
          <div className="grid grid-cols-[repeat(auto-fill,minmax(160px,1fr))] gap-4">
            {projects.map((project, i) => {
              const color = TILE_COLORS[i % TILE_COLORS.length];
              return (
                <ProjectTile
                  key={project.id}
                  project={project}
                  color={color}
                  onClick={() => handleOpenProject(project)}
                  onDelete={() => handleDeleteProject(project.id)}
                />
              );
            })}

            {/* Add project tile */}
            <button
              onClick={() => setCreatingProject(true)}
              className="aspect-square rounded-2xl border border-dashed border-zinc-700
                         flex flex-col items-center justify-center gap-2
                         hover:border-zinc-500 hover:bg-zinc-900/40
                         transition-colors cursor-pointer"
            >
              <Plus className="w-7 h-7 text-zinc-600" />
              <span className="text-xs text-zinc-600">New Project</span>
            </button>
          </div>

          {projects.length === 0 && (
            <div className="flex flex-col items-center justify-center py-16 text-zinc-600">
              <FolderOpen className="w-12 h-12 mb-3 opacity-30" />
              <p className="text-sm">No projects yet</p>
              <p className="text-xs mt-1 text-zinc-700">Create a project to get started</p>
            </div>
          )}

          {/* All recordings in the database */}
          <AllRecordingsSection
            recordings={allRecs}
            layout={recsLayout}
            onLayoutChange={setRecsLayout}
            onSelect={handleOpenRecording}
            onOpenPlayer={onOpenPlayer}
            onDelete={handleDeleteRecording}
          />
        </div>
      </div>
    );
  }

  // ── Standalone recording detail (opened from "All Recordings") ──────────────
  if (view === "recording" && selectedRec) {
    return (
      <div className="flex flex-col h-full">
        <div className="flex items-center gap-3 px-4 py-3 border-b border-zinc-800 shrink-0">
          <button
            onClick={handleBack}
            className="flex items-center gap-1.5 text-zinc-400 hover:text-white transition-colors cursor-pointer"
          >
            <ArrowLeft className="w-4 h-4" />
          </button>
          <span className="text-xs text-zinc-500">All Recordings</span>
          <span className="text-zinc-700">/</span>
          <span className="text-sm font-medium text-white truncate">{selectedRec.name}</span>
        </div>
        {error && (
          <div className="mx-4 mt-2 px-3 py-2 bg-red-950 border border-red-800 rounded text-red-300 text-xs shrink-0">
            {error}
          </div>
        )}
        <div className="flex-1 min-h-0 overflow-auto">
          <RecordingDetail
            rec={selectedRec}
            onNavigate={onNavigate}
            onOpenPlayer={onOpenPlayer}
            onRemove={() => handleDeleteRecording(selectedRec.id)}
            removeLabel="Delete recording"
          />
        </div>
      </div>
    );
  }

  // ── Project detail view ────────────────────────────────────────────────────
  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center gap-3 px-4 py-3 border-b border-zinc-800 shrink-0">
        <button
          onClick={selectedRec ? () => setSelectedRec(null) : handleBack}
          className="flex items-center gap-1.5 text-zinc-400 hover:text-white transition-colors cursor-pointer"
        >
          <ArrowLeft className="w-4 h-4" />
        </button>
        <span className="text-xs text-zinc-500">{openProject?.name}</span>
        {selectedRec && (
          <>
            <span className="text-zinc-700">/</span>
            <span className="text-sm font-medium text-white truncate">{selectedRec.name}</span>
          </>
        )}
        <div className="ml-auto flex items-center gap-2">
          <button
            onClick={handleImport}
            disabled={importing}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs text-white
                       bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50
                       rounded-lg transition-colors cursor-pointer"
          >
            <Upload className="w-3.5 h-3.5" />
            {importing ? "Importing…" : "Import Recording"}
          </button>
        </div>
      </div>

      {error && (
        <div className="mx-4 mt-2 px-3 py-2 bg-red-950 border border-red-800 rounded text-red-300 text-xs shrink-0">
          {error}
        </div>
      )}

      {/* Full-width content */}
      <div className="flex-1 min-h-0 overflow-auto">
        {selectedRec ? (
          <RecordingDetail
            rec={selectedRec}
            onNavigate={onNavigate}
            onOpenPlayer={onOpenPlayer}
            onRemove={() => handleRemoveRecording(selectedRec.id)}
          />
        ) : (
          <ProjectOverview
            project={openProject!}
            recordings={projectRecs}
            onSelect={setSelectedRec}
            onOpenPlayer={onOpenPlayer}
            onImport={handleImport}
          />
        )}
      </div>
    </div>
  );
}

// ─── ProjectBadges ────────────────────────────────────────────────────────────

function ProjectBadges({ projects, compact = false }: { projects: ProjectRef[]; compact?: boolean }) {
  if (!projects || projects.length === 0) {
    return compact ? null : <span className="text-[10px] text-zinc-700 italic">No project</span>;
  }
  return (
    <span className="flex items-center gap-1 flex-wrap">
      {projects.map((p) => (
        <span
          key={p.id}
          className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full
                     bg-zinc-800 border border-zinc-700 text-[10px] text-zinc-300 max-w-[120px]"
          title={p.name}
        >
          <FolderOpen className="w-2.5 h-2.5 text-indigo-400 shrink-0" />
          <span className="truncate">{p.name}</span>
        </span>
      ))}
    </span>
  );
}

// ─── AllRecordingsSection ─────────────────────────────────────────────────────

function AllRecordingsSection({
  recordings, layout, onLayoutChange, onSelect, onOpenPlayer, onDelete,
}: {
  recordings: RecordingMeta[];
  layout: "list" | "grid";
  onLayoutChange: (l: "list" | "grid") => void;
  onSelect: (rec: RecordingMeta) => void;
  onOpenPlayer: (id: string) => void;
  onDelete: (id: string) => void;
}) {
  return (
    <div className="mt-8">
      <div className="flex items-center gap-3 mb-3">
        <h3 className="text-sm font-semibold text-zinc-300">All Recordings</h3>
        <span className="text-xs text-zinc-600">{recordings.length}</span>
        <div className="ml-auto flex items-center gap-1 bg-zinc-900 border border-zinc-800 rounded-lg p-0.5">
          <button
            onClick={() => onLayoutChange("list")}
            className={`p-1.5 rounded-md transition-colors cursor-pointer ${
              layout === "list" ? "bg-zinc-800 text-white" : "text-zinc-600 hover:text-zinc-400"
            }`}
            title="List view"
          >
            <List className="w-3.5 h-3.5" />
          </button>
          <button
            onClick={() => onLayoutChange("grid")}
            className={`p-1.5 rounded-md transition-colors cursor-pointer ${
              layout === "grid" ? "bg-zinc-800 text-white" : "text-zinc-600 hover:text-zinc-400"
            }`}
            title="Grid view"
          >
            <LayoutGrid className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      {recordings.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-12 text-zinc-600 border border-dashed border-zinc-800 rounded-xl">
          <Upload className="w-8 h-8 mb-2 opacity-30" />
          <p className="text-xs">No recordings in the database yet</p>
        </div>
      ) : layout === "list" ? (
        <div className="rounded-xl border border-zinc-800 overflow-hidden divide-y divide-zinc-800/60">
          {recordings.map((rec) => (
            <AllRecordingsRow
              key={rec.id}
              rec={rec}
              onSelect={() => onSelect(rec)}
              onOpenPlayer={() => onOpenPlayer(rec.id)}
              onDelete={() => onDelete(rec.id)}
            />
          ))}
        </div>
      ) : (
        <div className="grid grid-cols-[repeat(auto-fill,minmax(240px,1fr))] gap-4">
          {recordings.map((rec) => (
            <button
              key={rec.id}
              onClick={() => onSelect(rec)}
              className="group text-left rounded-xl border border-zinc-800 bg-zinc-900/60
                         hover:border-zinc-600 hover:bg-zinc-800/80 transition-all cursor-pointer
                         overflow-hidden"
            >
              <div className="relative">
                <VideoThumbnailMedium recordingId={rec.id} />
                <div className="absolute inset-0 flex items-center justify-center
                                bg-black/0 group-hover:bg-black/40 transition-colors">
                  <Play className="w-7 h-7 text-white opacity-0 group-hover:opacity-100 transition-opacity" />
                </div>
                {rec.has_gaze_result && (
                  <span className="absolute top-1.5 right-1.5 text-[9px] px-1.5 py-0.5 rounded-full
                                   bg-emerald-950/90 text-emerald-400 border border-emerald-800">
                    Gaze ✓
                  </span>
                )}
              </div>
              <div className="px-3 py-2.5 space-y-1.5">
                <p className="text-xs text-white truncate font-medium">{rec.name}</p>
                <p className="text-[10px] text-zinc-500 flex items-center gap-1.5">
                  {rec.wearer_name && <span>{rec.wearer_name}</span>}
                  {rec.duration_sec != null && <span>· {formatDuration(rec.duration_sec)}</span>}
                </p>
                <ProjectBadges projects={rec.projects ?? []} compact />
              </div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function AllRecordingsRow({
  rec, onSelect, onOpenPlayer, onDelete,
}: {
  rec: RecordingMeta;
  onSelect: () => void;
  onOpenPlayer: () => void;
  onDelete: () => void;
}) {
  return (
    <div
      onClick={onSelect}
      className="flex items-center gap-3 px-4 py-2.5 bg-zinc-900/40 hover:bg-zinc-900
                 transition-colors group cursor-pointer"
    >
      <VideoThumbnail recordingId={rec.id} />
      <div className="flex-1 min-w-0">
        <p className="text-xs font-medium text-white truncate">{rec.name}</p>
        <p className="text-[10px] text-zinc-500 mt-0.5">{formatDate(rec.start_time)}</p>
      </div>
      <div className="hidden sm:flex items-center gap-2 min-w-0 max-w-[240px] shrink">
        <ProjectBadges projects={rec.projects ?? []} />
      </div>
      <span className="flex items-center gap-1.5 w-24 text-[11px] text-zinc-400 shrink-0">
        <User className="w-3 h-3 shrink-0" />
        <span className="truncate">{rec.wearer_name ?? "—"}</span>
      </span>
      <span className="flex items-center gap-1.5 w-12 text-[11px] text-zinc-400 shrink-0">
        <Clock className="w-3 h-3 shrink-0" />
        {formatDuration(rec.duration_sec)}
      </span>
      <span className={`text-[9px] px-1.5 py-0.5 rounded-full shrink-0 ${
        rec.has_gaze_result
          ? "bg-emerald-950 text-emerald-400 border border-emerald-800"
          : "bg-zinc-800 text-zinc-600"
      }`}>
        {rec.has_gaze_result ? "Gaze ✓" : "–"}
      </span>
      <button
        onClick={(e) => { e.stopPropagation(); onOpenPlayer(); }}
        className="opacity-0 group-hover:opacity-100 p-1 text-zinc-600 hover:text-indigo-400
                   transition-all cursor-pointer rounded shrink-0"
        title="Open player"
      >
        <Play className="w-3.5 h-3.5" />
      </button>
      <button
        onClick={(e) => { e.stopPropagation(); onDelete(); }}
        className="opacity-0 group-hover:opacity-100 p-1 text-zinc-600 hover:text-red-400
                   transition-all cursor-pointer rounded shrink-0"
        title="Delete recording"
      >
        <Trash2 className="w-3.5 h-3.5" />
      </button>
    </div>
  );
}

// ─── ProjectTile ──────────────────────────────────────────────────────────────

function ProjectTile({
  project, color, onClick, onDelete,
}: {
  project: Project;
  color: typeof TILE_COLORS[number];
  onClick: () => void;
  onDelete: () => void;
}) {
  return (
    <div className="relative group aspect-square">
      <button
        onClick={onClick}
        className={`w-full h-full rounded-2xl border ${color.border} ${color.bg} ${color.hover}
                    flex flex-col items-center justify-center gap-3
                    transition-all cursor-pointer p-4`}
      >
        <FolderOpen className={`w-10 h-10 ${color.icon}`} />
        <div className="text-center">
          <p className="text-sm font-medium text-white leading-tight line-clamp-2">{project.name}</p>
          <p className="text-xs text-zinc-500 mt-1">
            {project.recording_count} rec{project.recording_count !== 1 ? "s" : ""}
          </p>
        </div>
      </button>
      <button
        onClick={(e) => { e.stopPropagation(); onDelete(); }}
        className="absolute top-2 right-2 p-1 rounded-md
                   opacity-0 group-hover:opacity-100
                   text-zinc-600 hover:text-red-400 hover:bg-zinc-800
                   transition-all cursor-pointer"
      >
        <Trash2 className="w-3.5 h-3.5" />
      </button>
    </div>
  );
}

// ─── RecordingListItem ────────────────────────────────────────────────────────

function RecordingListItem({
  rec, selected, onSelect, onRemove,
}: {
  rec: RecordingMeta;
  selected: boolean;
  onSelect: () => void;
  onRemove: () => void;
}) {
  return (
    <button
      onClick={onSelect}
      className={`w-full flex items-center gap-2.5 px-3 py-2.5 text-left
                  border-b border-zinc-800/40 transition-colors group cursor-pointer
                  ${selected
                    ? "bg-indigo-600/10 border-l-2 border-l-indigo-500"
                    : "hover:bg-zinc-900/60"
                  }`}
    >
      <VideoThumbnail recordingId={rec.id} />
      <div className="flex-1 min-w-0">
        <p className="text-xs font-medium text-white truncate">{rec.name}</p>
        <p className="text-[10px] text-zinc-600 mt-0.5 flex items-center gap-1.5">
          {rec.wearer_name && <span className="flex items-center gap-0.5"><User className="w-2.5 h-2.5" />{rec.wearer_name}</span>}
          {rec.duration_sec != null && <span className="flex items-center gap-0.5"><Clock className="w-2.5 h-2.5" />{formatDuration(rec.duration_sec)}</span>}
        </p>
      </div>
      <div className="flex flex-col items-end gap-1 shrink-0">
        <span className={`text-[9px] px-1.5 py-0.5 rounded-full ${
          rec.has_gaze_result
            ? "bg-emerald-950 text-emerald-400 border border-emerald-800"
            : "bg-zinc-800 text-zinc-600"
        }`}>
          {rec.has_gaze_result ? "Gaze ✓" : "–"}
        </span>
        <button
          onClick={(e) => { e.stopPropagation(); onRemove(); }}
          className="opacity-0 group-hover:opacity-100 p-0.5 text-zinc-600 hover:text-red-400
                     transition-all cursor-pointer"
          title="Remove from project"
        >
          <Trash2 className="w-3 h-3" />
        </button>
      </div>
    </button>
  );
}

// ─── ProjectOverview ──────────────────────────────────────────────────────────

function ProjectOverview({
  project, recordings, onSelect, onOpenPlayer, onImport,
}: {
  project: Project;
  recordings: RecordingMeta[];
  onSelect: (rec: RecordingMeta) => void;
  onOpenPlayer: (id: string) => void;
  onImport: () => void;
}) {
  const gazeCount = recordings.filter((r) => r.has_gaze_result).length;
  const total = recordings.length;

  return (
    <div className="p-6">
      {total > 0 ? (
        <div>
          <div className="grid grid-cols-[repeat(auto-fill,minmax(300px,1fr))] gap-4">
            {recordings.map((rec) => (
              <button
                key={rec.id}
                onClick={() => onSelect(rec)}
                className="group text-left rounded-xl border border-zinc-800 bg-zinc-900/60
                           hover:border-zinc-600 hover:bg-zinc-800/80 transition-all cursor-pointer
                           overflow-hidden"
              >
                <div className="relative">
                  <VideoThumbnailMedium recordingId={rec.id} />
                  <div className="absolute inset-0 flex items-center justify-center
                                  bg-black/0 group-hover:bg-black/40 transition-colors">
                    <Play className="w-7 h-7 text-white opacity-0 group-hover:opacity-100 transition-opacity" />
                  </div>
                  {rec.has_gaze_result && (
                    <span className="absolute top-1.5 right-1.5 text-[9px] px-1.5 py-0.5 rounded-full
                                     bg-emerald-950/90 text-emerald-400 border border-emerald-800">
                      Gaze ✓
                    </span>
                  )}
                </div>
                <div className="px-3 py-2.5">
                  <p className="text-xs text-white truncate font-medium">{rec.name}</p>
                  <p className="text-[10px] text-zinc-500 mt-0.5 flex items-center gap-1.5">
                    {rec.wearer_name && <span>{rec.wearer_name}</span>}
                    {rec.duration_sec != null && <span>· {formatDuration(rec.duration_sec)}</span>}
                  </p>
                </div>
              </button>
            ))}
          </div>
        </div>
      ) : (
        <div className="flex flex-col items-center justify-center py-20 text-zinc-600">
          <Upload className="w-10 h-10 mb-3 opacity-30" />
          <p className="text-sm">No recordings in this project</p>
          <p className="text-xs mt-1 text-zinc-700">Use «Import Recording» to add one</p>
        </div>
      )}
    </div>
  );
}


// ─── RecordingDetail ──────────────────────────────────────────────────────────

function RecordingDetail({
  rec, onNavigate, onOpenPlayer, onRemove, removeLabel = "Remove from project",
}: {
  rec: RecordingMeta;
  onNavigate: (page: "gaze" | "events" | "aoi", recording: RecordingMeta) => void;
  onOpenPlayer: (id: string) => void;
  onRemove: () => void;
  removeLabel?: string;
}) {
  return (
    <div className="p-6 flex gap-8">
      {/* Left: video + metadata */}
      <div className="flex-1 min-w-0 space-y-4 max-w-lg">
        <VideoThumbnailLarge recordingId={rec.id} onPlay={() => onOpenPlayer(rec.id)} />
        <div className="space-y-1.5">
          {rec.projects && rec.projects.length > 0 && (
            <div className="flex items-center gap-2 flex-wrap pb-1">
              <FolderOpen className="w-3.5 h-3.5 shrink-0 text-zinc-400" />
              <ProjectBadges projects={rec.projects} />
            </div>
          )}
          {rec.wearer_name && (
            <p className="text-sm text-zinc-400 flex items-center gap-2">
              <User className="w-3.5 h-3.5 shrink-0" />{rec.wearer_name}
            </p>
          )}
          {rec.duration_sec != null && (
            <p className="text-sm text-zinc-400 flex items-center gap-2">
              <Clock className="w-3.5 h-3.5 shrink-0" />{formatDuration(rec.duration_sec)}
            </p>
          )}
          {rec.start_time != null && (
            <p className="text-sm text-zinc-400 flex items-center gap-2">
              <CalendarClock className="w-3.5 h-3.5 shrink-0" />{formatDate(rec.start_time)}
            </p>
          )}
          <p className="text-sm flex items-center gap-2">
            <Brain className="w-3.5 h-3.5 shrink-0 text-zinc-400" />
            <span className={rec.has_gaze_result ? "text-emerald-400" : "text-zinc-600"}>
              {rec.has_gaze_result ? "Gaze ready" : "No gaze computed"}
            </span>
          </p>
        </div>
        <button
          onClick={onRemove}
          className="flex items-center gap-1.5 text-xs text-zinc-600 hover:text-red-400
                     transition-colors cursor-pointer"
        >
          <Trash2 className="w-3.5 h-3.5" /> {removeLabel}
        </button>
      </div>

      {/* Right: actions */}
      <div className="w-72 shrink-0 space-y-3 pt-1">
        <p className="text-xs text-zinc-600 uppercase tracking-wider">Actions</p>
        <ActionButton
          icon={<Brain className="w-4 h-4" />}
          label="Calculate Gaze"
          description="Detect pupils, calibrate & map gaze"
          onClick={() => onNavigate("gaze", rec)}
        />
        <ActionButton
          icon={<Flag className="w-4 h-4" />}
          label="Annotate Events"
          description="Mark events on the video timeline"
          onClick={() => onNavigate("events", rec)}
        />
        <ActionButton
          icon={<Target className="w-4 h-4" />}
          label="Annotate AoI"
          description="Draw areas of interest on the scene"
          onClick={() => onNavigate("aoi", rec)}
        />
      </div>
    </div>
  );
}

function ActionButton({ icon, label, description, onClick }: {
  icon: React.ReactNode;
  label: string;
  description: string;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className="w-full flex items-center gap-3 px-4 py-3
                 bg-zinc-800/60 hover:bg-zinc-800 border border-zinc-700/50
                 hover:border-zinc-600 rounded-xl transition-colors cursor-pointer text-left"
    >
      <span className="text-indigo-400 shrink-0">{icon}</span>
      <div className="flex-1 min-w-0">
        <p className="text-sm text-white font-medium">{label}</p>
        <p className="text-xs text-zinc-500">{description}</p>
      </div>
      <ChevronRight className="w-4 h-4 text-zinc-600 shrink-0" />
    </button>
  );
}

// ─── Video helpers ────────────────────────────────────────────────────────────

function VideoThumbnailMedium({ recordingId }: { recordingId: string }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [error, setError] = useState(false);

  if (error) {
    return (
      <div className="w-full aspect-video bg-indigo-950 flex items-center justify-center">
        <Cpu className="w-6 h-6 text-indigo-400" />
      </div>
    );
  }

  return (
    <video
      ref={videoRef}
      src={`${API}/api/recordings/${recordingId}/video/scene`}
      className="w-full aspect-video object-cover bg-zinc-800"
      preload="metadata"
      muted
      playsInline
      onLoadedMetadata={() => {
        const v = videoRef.current;
        if (v) v.currentTime = Math.min(2, v.duration * 0.1);
      }}
      onError={() => setError(true)}
    />
  );
}

function VideoThumbnail({ recordingId }: { recordingId: string }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [error, setError] = useState(false);

  if (error) {
    return (
      <div className="w-12 h-7 rounded bg-indigo-950 flex items-center justify-center shrink-0">
        <Cpu className="w-3.5 h-3.5 text-indigo-400" />
      </div>
    );
  }

  return (
    <video
      ref={videoRef}
      src={`${API}/api/recordings/${recordingId}/video/scene`}
      className="w-12 h-7 rounded object-cover shrink-0 bg-zinc-800"
      preload="metadata"
      muted
      playsInline
      onLoadedMetadata={() => {
        const v = videoRef.current;
        if (v) v.currentTime = Math.min(2, v.duration * 0.1);
      }}
      onError={() => setError(true)}
    />
  );
}

function VideoThumbnailLarge({ recordingId, onPlay }: { recordingId: string; onPlay: () => void }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [error, setError] = useState(false);

  if (error) {
    return (
      <div className="w-full aspect-video rounded-xl bg-indigo-950 flex items-center justify-center">
        <Cpu className="w-8 h-8 text-indigo-400" />
      </div>
    );
  }

  return (
    <div className="relative group cursor-pointer" onClick={onPlay}>
      <video
        ref={videoRef}
        src={`${API}/api/recordings/${recordingId}/video/scene`}
        className="w-full aspect-video rounded-xl object-cover bg-zinc-800"
        preload="metadata"
        muted
        playsInline
        onLoadedMetadata={() => {
          const v = videoRef.current;
          if (v) v.currentTime = Math.min(2, v.duration * 0.1);
        }}
        onError={() => setError(true)}
      />
      <div className="absolute inset-0 flex items-center justify-center
                      bg-black/0 group-hover:bg-black/40 transition-colors rounded-xl">
        <Play className="w-8 h-8 text-white opacity-0 group-hover:opacity-100 transition-opacity" />
      </div>
    </div>
  );
}
