import { useEffect, useState } from "react";
import { Plus, Layers, Trash2, ChevronRight, X, Check } from "lucide-react";
import { api } from "@/lib/api";
import { formatDuration, formatDate } from "@/lib/utils";
import type { Project, RecordingMeta } from "@/types";

export function ProjectsPage() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [loading, setLoading] = useState(true);
  const [openProject, setOpenProject] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [error, setError] = useState<string | null>(null);

  const fetchProjects = async () => {
    try {
      const data = await api.get<Project[]>("/api/projects");
      setProjects(data);
    } catch {
      setError("Backend недоступен");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { fetchProjects(); }, []);

  const handleCreate = async () => {
    if (!newName.trim()) return;
    try {
      await api.post<Project>("/api/projects", { name: newName.trim() });
      setNewName("");
      setCreating(false);
      await fetchProjects();
    } catch {
      setError("Ошибка создания проекта");
    }
  };

  const handleDelete = async (id: string) => {
    try {
      await api.delete(`/api/projects/${id}`);
      setProjects((prev) => prev.filter((p) => p.id !== id));
      if (openProject === id) setOpenProject(null);
    } catch {
      setError("Ошибка удаления");
    }
  };

  return (
    <div className="flex h-full">
      {/* Projects list */}
      <div className="w-80 border-r border-zinc-800 flex flex-col">
        <div className="flex items-center justify-between px-6 py-3 border-b border-zinc-800">
          <span className="text-sm font-medium text-white">Projects</span>
          <button
            onClick={() => setCreating(true)}
            className="p-1 text-zinc-400 hover:text-white transition-colors cursor-pointer"
            title="New project"
          >
            <Plus className="w-4 h-4" />
          </button>
        </div>

        {creating && (
          <div className="px-3 py-2 border-b border-zinc-800 flex items-center gap-2">
            <input
              autoFocus
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") handleCreate();
                if (e.key === "Escape") { setCreating(false); setNewName(""); }
              }}
              placeholder="Project name…"
              className="flex-1 bg-zinc-800 text-white text-sm px-2 py-1 rounded outline-none
                         border border-zinc-700 focus:border-indigo-500 placeholder:text-zinc-600"
            />
            <button onClick={handleCreate} className="text-emerald-400 hover:text-emerald-300 cursor-pointer">
              <Check className="w-4 h-4" />
            </button>
            <button onClick={() => { setCreating(false); setNewName(""); }}
              className="text-zinc-500 hover:text-zinc-300 cursor-pointer">
              <X className="w-4 h-4" />
            </button>
          </div>
        )}

        {error && (
          <div className="mx-3 mt-2 px-3 py-2 bg-red-950 border border-red-800 rounded text-red-300 text-xs">
            {error}
          </div>
        )}

        <div className="flex-1 overflow-auto">
          {loading ? (
            <p className="text-zinc-500 text-xs p-4">Loading…</p>
          ) : projects.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-12 text-zinc-600">
              <Layers className="w-8 h-8 mb-2 opacity-30" />
              <p className="text-xs">No projects yet</p>
            </div>
          ) : (
            projects.map((p) => (
              <button
                key={p.id}
                onClick={() => setOpenProject(p.id === openProject ? null : p.id)}
                className={`w-full flex items-center gap-3 px-4 py-3 text-left
                            border-b border-zinc-800/50 transition-colors group cursor-pointer
                            ${openProject === p.id ? "bg-zinc-800" : "hover:bg-zinc-900"}`}
              >
                <Layers className="w-4 h-4 text-indigo-400 shrink-0" />
                <div className="flex-1 min-w-0">
                  <p className="text-sm text-white truncate">{p.name}</p>
                  <p className="text-xs text-zinc-500">{p.recording_count} recording{p.recording_count !== 1 ? "s" : ""}</p>
                </div>
                <ChevronRight className={`w-3.5 h-3.5 text-zinc-600 transition-transform
                  ${openProject === p.id ? "rotate-90" : ""}`} />
                <button
                  onClick={(e) => { e.stopPropagation(); handleDelete(p.id); }}
                  className="opacity-0 group-hover:opacity-100 p-1 text-zinc-600
                             hover:text-red-400 transition-all cursor-pointer"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              </button>
            ))
          )}
        </div>
      </div>

      {/* Project detail */}
      <div className="flex-1 overflow-auto">
        {openProject ? (
          <ProjectDetail
            projectId={openProject}
            projectName={projects.find((p) => p.id === openProject)?.name ?? ""}
            onRecordingCountChange={fetchProjects}
          />
        ) : (
          <div className="flex items-center justify-center h-full text-zinc-600">
            <p className="text-sm">Select a project to manage recordings</p>
          </div>
        )}
      </div>
    </div>
  );
}

function ProjectDetail({
  projectId,
  projectName,
  onRecordingCountChange,
}: {
  projectId: string;
  projectName: string;
  onRecordingCountChange: () => void;
}) {
  const [attached, setAttached] = useState<RecordingMeta[]>([]);
  const [all, setAll] = useState<RecordingMeta[]>([]);
  const [adding, setAdding] = useState(false);

  const fetchAttached = async () => {
    const data = await api.get<RecordingMeta[]>(`/api/projects/${projectId}/recordings`);
    setAttached(data);
  };

  const fetchAll = async () => {
    const data = await api.get<RecordingMeta[]>("/api/recordings");
    setAll(data);
  };

  useEffect(() => {
    fetchAttached();
    fetchAll();
  }, [projectId]);

  const attachedIds = new Set(attached.map((r) => r.id));
  const available = all.filter((r) => !attachedIds.has(r.id));

  const handleAdd = async (recordingId: string) => {
    await api.post(`/api/projects/${projectId}/recordings`, { recording_id: recordingId });
    await fetchAttached();
    onRecordingCountChange();
  };

  const handleRemove = async (recordingId: string) => {
    await api.delete(`/api/projects/${projectId}/recordings/${recordingId}`);
    await fetchAttached();
    onRecordingCountChange();
  };

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold text-white">{projectName}</h2>
        {available.length > 0 && (
          <button
            onClick={() => setAdding(!adding)}
            className="flex items-center gap-2 px-3 py-1.5 bg-zinc-800 hover:bg-zinc-700
                       text-white text-sm rounded-lg transition-colors cursor-pointer"
          >
            <Plus className="w-3.5 h-3.5" />
            Add Recording
          </button>
        )}
      </div>

      {adding && available.length > 0 && (
        <div className="space-y-2">
          <p className="text-xs text-zinc-500 uppercase tracking-wider">Available recordings</p>
          {available.map((rec) => (
            <div key={rec.id}
              className="flex items-center gap-3 px-4 py-3 bg-zinc-900 border border-zinc-800
                         rounded-lg hover:border-zinc-700 transition-colors">
              <div className="flex-1 min-w-0">
                <p className="text-sm text-white truncate">{rec.name}</p>
                <p className="text-xs text-zinc-500">
                  {rec.wearer_name} · {formatDuration(rec.duration_sec)} · {formatDate(rec.start_time)}
                </p>
              </div>
              <button
                onClick={() => handleAdd(rec.id)}
                className="px-3 py-1 bg-indigo-600 hover:bg-indigo-500 text-white
                           text-xs rounded-md transition-colors cursor-pointer"
              >
                Add
              </button>
            </div>
          ))}
        </div>
      )}

      <div className="space-y-2">
        <p className="text-xs text-zinc-500 uppercase tracking-wider">
          Recordings in project ({attached.length})
        </p>
        {attached.length === 0 ? (
          <p className="text-sm text-zinc-600 py-4">No recordings added yet.</p>
        ) : (
          attached.map((rec) => (
            <div key={rec.id}
              className="flex items-center gap-3 px-4 py-3 bg-zinc-900 border border-zinc-800
                         rounded-lg group hover:border-zinc-700 transition-colors">
              <div className="flex-1 min-w-0">
                <p className="text-sm text-white truncate">{rec.name}</p>
                <p className="text-xs text-zinc-500">
                  {rec.wearer_name} · {formatDuration(rec.duration_sec)} · {formatDate(rec.start_time)}
                </p>
              </div>
              <span className={`text-xs px-2 py-0.5 rounded-full ${rec.has_gaze_result
                ? "bg-emerald-950 text-emerald-400 border border-emerald-800"
                : "bg-zinc-800 text-zinc-500"}`}>
                {rec.has_gaze_result ? "Gaze ready" : "No gaze"}
              </span>
              <button
                onClick={() => handleRemove(rec.id)}
                className="opacity-0 group-hover:opacity-100 p-1 text-zinc-600
                           hover:text-red-400 transition-all cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
