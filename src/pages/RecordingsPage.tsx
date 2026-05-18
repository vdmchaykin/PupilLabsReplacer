import { useEffect, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { Upload, Clock, User, Cpu, Brain, Trash2, Play } from "lucide-react";
import { api } from "@/lib/api";
import { formatDuration, formatDate } from "@/lib/utils";
import type { RecordingMeta } from "@/types";

interface RecordingsPageProps {
  onOpenPlayer: (id: string) => void;
}

export function RecordingsPage({ onOpenPlayer }: RecordingsPageProps) {
  const [recordings, setRecordings] = useState<RecordingMeta[]>([]);
  const [loading, setLoading] = useState(true);
  const [importing, setImporting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchRecordings = async () => {
    try {
      const data = await api.get<RecordingMeta[]>("/api/recordings");
      setRecordings(data);
    } catch {
      setError("Backend недоступен");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { fetchRecordings(); }, []);

  const handleImport = async () => {
    const nativePath = await open({
      filters: [{ name: "ZIP Archive", extensions: ["zip"] }],
      title: "Select Native Recording Data zip",
    });
    if (!nativePath) return;

    setImporting(true);
    setError(null);
    try {
      await api.post<RecordingMeta>("/api/recordings/import", {
        native_zip_path: nativePath,
      });
      await fetchRecordings();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Ошибка импорта");
    } finally {
      setImporting(false);
    }
  };

  const handleDelete = async (id: string) => {
    try {
      await api.delete(`/api/recordings/${id}`);
      setRecordings((prev) => prev.filter((r) => r.id !== id));
    } catch {
      setError("Ошибка удаления");
    }
  };

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold text-white">Recordings</h2>
          <p className="text-xs text-zinc-500 mt-0.5">
            {recordings.length} recording{recordings.length !== 1 ? "s" : ""}
          </p>
        </div>
        <button
          onClick={handleImport}
          disabled={importing}
          className="flex items-center gap-2 px-4 py-2 bg-indigo-600 hover:bg-indigo-500
                     disabled:opacity-50 disabled:cursor-not-allowed
                     text-white text-sm font-medium rounded-lg transition-colors cursor-pointer"
        >
          <Upload className="w-4 h-4" />
          {importing ? "Importing…" : "Import Recording"}
        </button>
      </div>

      {error && (
        <div className="px-4 py-3 bg-red-950 border border-red-800 rounded-lg text-red-300 text-sm">
          {error}
        </div>
      )}

      {loading ? (
        <div className="text-zinc-500 text-sm">Loading…</div>
      ) : recordings.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-20 text-zinc-600">
          <Upload className="w-10 h-10 mb-3 opacity-40" />
          <p className="text-sm">No recordings yet</p>
          <p className="text-xs mt-1">Import a Native Recording Data zip to get started — CSV files will be generated automatically</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-3">
          {recordings.map((rec) => (
            <RecordingCard
              key={rec.id}
              rec={rec}
              onDelete={() => handleDelete(rec.id)}
              onOpen={() => onOpenPlayer(rec.id)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function RecordingCard({
  rec,
  onDelete,
  onOpen,
}: {
  rec: RecordingMeta;
  onDelete: () => void;
  onOpen: () => void;
}) {
  return (
    <div className="flex items-center gap-4 px-5 py-4 bg-zinc-900 border border-zinc-800
                    rounded-xl hover:border-zinc-700 transition-colors group">
      <div className="w-10 h-10 rounded-lg bg-indigo-950 flex items-center justify-center shrink-0">
        <Cpu className="w-5 h-5 text-indigo-400" />
      </div>

      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium text-white truncate">{rec.name}</p>
        <p className="text-xs text-zinc-500 mt-0.5">{formatDate(rec.start_time)}</p>
      </div>

      <div className="flex items-center gap-6 text-xs text-zinc-400 shrink-0">
        <span className="flex items-center gap-1.5">
          <User className="w-3.5 h-3.5" />
          {rec.wearer_name ?? "—"}
        </span>
        <span className="flex items-center gap-1.5">
          <Clock className="w-3.5 h-3.5" />
          {formatDuration(rec.duration_sec)}
        </span>
        <span className="flex items-center gap-1.5">
          <Brain className="w-3.5 h-3.5" />
          <span className={rec.has_gaze_result ? "text-emerald-400" : "text-zinc-600"}>
            {rec.has_gaze_result ? "Gaze ready" : "No gaze"}
          </span>
        </span>
        <span className="flex items-center gap-1.5 text-zinc-600">
          {rec.scene_video ? "🎥 Scene" : ""}
          {rec.eye_video ? "  👁 Eye" : ""}
        </span>
      </div>

      <button
        onClick={onOpen}
        className="opacity-0 group-hover:opacity-100 p-1.5 text-zinc-600
                   hover:text-indigo-400 transition-all cursor-pointer rounded"
        title="Open player"
      >
        <Play className="w-4 h-4" />
      </button>

      <button
        onClick={onDelete}
        className="opacity-0 group-hover:opacity-100 p-1.5 text-zinc-600
                   hover:text-red-400 transition-all cursor-pointer rounded"
        title="Remove recording"
      >
        <Trash2 className="w-4 h-4" />
      </button>
    </div>
  );
}
