import { useState, useEffect, useRef } from "react";
import { Play, RefreshCw, CheckCircle2, Trash2 } from "lucide-react";
import type { GazeAnalysisState, RecordingMeta } from "@/types";

const API = "http://localhost:8765";

interface Props {
  recording: RecordingMeta;
  done: boolean;
  onDone: () => void;
  onDeleted: (state: GazeAnalysisState) => void;
}

interface DetectStatus {
  status: "idle" | "running" | "done" | "error";
  progress: number;
  total: number;
  mean_confidence: number;
  message?: string;
}

export function GazeDetectStep({ recording, done: initialDone, onDone, onDeleted }: Props) {
  // Floodfill (primary) detector knobs — see backend DetectRequest
  const [roiSize, setRoiSize] = useState(35);
  const [loDiff, setLoDiff] = useState(25);
  const [hiDiff, setHiDiff] = useState(15);
  const [blurKsize, setBlurKsize] = useState(3);
  const [minArea, setMinArea] = useState(40);
  const [minFillFrac, setMinFillFrac] = useState(0.55);
  const [maxAspect, setMaxAspect] = useState(1.8);
  const [seedSearch, setSeedSearch] = useState(10);
  const [lashOpenKsize, setLashOpenKsize] = useState(9);

  const [jobStatus, setJobStatus] = useState<DetectStatus>({
    status: initialDone ? "done" : "idle",
    progress: 0,
    total: 0,
    mean_confidence: 0,
  });

  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const cancelledRef = useRef(false);

  const stopPolling = () => {
    if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
  };

  const pollStatus = async () => {
    if (cancelledRef.current) return;
    try {
      const res = await fetch(`${API}/api/recordings/${recording.id}/gaze/detect-status`);
      if (!res.ok || cancelledRef.current) return;
      const data: DetectStatus = await res.json();
      if (cancelledRef.current) return;
      setJobStatus(data);
      if (data.status === "done") { stopPolling(); onDone(); }
      if (data.status === "error") stopPolling();
    } catch { /* backend might be starting */ }
  };

  // On mount: check backend status and resume polling if a job is still running
  useEffect(() => {
    cancelledRef.current = false;

    fetch(`${API}/api/recordings/${recording.id}/gaze/detect-status`)
      .then((r) => (r.ok ? r.json() : null))
      .then((data: DetectStatus | null) => {
        if (!data || cancelledRef.current) return;
        setJobStatus(data);
        if (data.status === "running") {
          pollRef.current = setInterval(pollStatus, 800);
        } else if (data.status === "done" && !initialDone) {
          onDone();
        }
      })
      .catch(() => {});

    return () => { cancelledRef.current = true; stopPolling(); };
  }, []);

  const handleRun = async () => {
    setJobStatus({ status: "running", progress: 0, total: 0, mean_confidence: 0, message: "Starting…" });
    try {
      const res = await fetch(`${API}/api/recordings/${recording.id}/gaze/detect-pupils`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          heatmap_roi_size: roiSize,
          floodfill_lo_diff: loDiff,
          floodfill_hi_diff: hiDiff,
          floodfill_blur_ksize: blurKsize,
          floodfill_min_area: minArea,
          floodfill_min_fill_frac: minFillFrac,
          floodfill_max_aspect: maxAspect,
          floodfill_seed_search: seedSearch,
          floodfill_lash_open_ksize: lashOpenKsize,
        }),
      });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        setJobStatus((s) => ({ ...s, status: "error", message: d.detail ?? `HTTP ${res.status}` }));
        return;
      }
      pollRef.current = setInterval(pollStatus, 800);
    } catch (e) {
      setJobStatus((s) => ({ ...s, status: "error", message: String(e) }));
    }
  };

  const handleCancel = async () => {
    await fetch(`${API}/api/recordings/${recording.id}/gaze/detect-cancel`, { method: "POST" });
    stopPolling();
    setJobStatus((s) => ({ ...s, status: "idle", message: undefined }));
  };

  const handleDelete = async () => {
    if (!confirm("Delete pupil detection data? This also clears calibration and mapping for this recording.")) return;
    try {
      const res = await fetch(`${API}/api/recordings/${recording.id}/gaze/data/pupils`, { method: "DELETE" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const state: GazeAnalysisState = await res.json();
      setJobStatus({ status: "idle", progress: 0, total: 0, mean_confidence: 0 });
      onDeleted(state);
    } catch (e) {
      setJobStatus((s) => ({ ...s, status: "error", message: String(e) }));
    }
  };

  const running = jobStatus.status === "running";
  const done = jobStatus.status === "done";
  const progress = jobStatus.total > 0 ? (jobStatus.progress / jobStatus.total) * 100 : 0;

  return (
    <div className="p-8 max-w-3xl mx-auto space-y-8">
      <div>
        <h2 className="text-lg font-semibold text-white">Step 1 — Pupil Detection</h2>
        <p className="text-sm text-zinc-400 mt-1">
          Detect pupil positions using HeatmapNet ROI + edge detection and ellipse fitting.
        </p>
      </div>

      <div className="grid grid-cols-2 gap-6">
        {/* Recording info */}
        <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-5 space-y-3">
          <p className="text-xs text-zinc-500 uppercase tracking-wider">Recording</p>
          <div className="space-y-1.5 text-sm">
            <Row label="Name" value={recording.name} />
            <Row label="Wearer" value={recording.wearer_name ?? "—"} />
            <Row label="Eye video" value={recording.eye_video ? "✅ present" : "❌ missing"} />
          </div>
        </div>

        {/* Config */}
        <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-5 space-y-3">
          <p className="text-xs text-zinc-500 uppercase tracking-wider">Floodfill configuration</p>
          <div className="space-y-2">
            <NumberInput label="ROI size (px)" value={roiSize} onChange={setRoiSize} disabled={running} />
            <NumberInput label="Lo diff" value={loDiff} onChange={setLoDiff} disabled={running} />
            <NumberInput label="Hi diff" value={hiDiff} onChange={setHiDiff} disabled={running} />
            <NumberInput label="Blur ksize" value={blurKsize} onChange={setBlurKsize} disabled={running} />
            <NumberInput label="Min area" value={minArea} onChange={setMinArea} disabled={running} />
            <NumberInput label="Min fill frac" value={minFillFrac} onChange={setMinFillFrac} disabled={running} step={0.05} />
            <NumberInput label="Max aspect" value={maxAspect} onChange={setMaxAspect} disabled={running} step={0.1} />
            <NumberInput label="Seed search (px)" value={seedSearch} onChange={setSeedSearch} disabled={running} />
            <NumberInput label="Lash open ksize" value={lashOpenKsize} onChange={setLashOpenKsize} disabled={running} />
          </div>
        </div>
      </div>

      {/* Status / progress */}
      <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-5 space-y-3">
        {done ? (
          <div className="flex items-center gap-3 text-emerald-400">
            <CheckCircle2 className="w-5 h-5" />
            <div>
              <p className="text-sm font-medium">Detection complete</p>
              <p className="text-xs text-zinc-400 mt-0.5">
                Mean confidence: {jobStatus.mean_confidence.toFixed(3)}
              </p>
            </div>
          </div>
        ) : running ? (
          <div className="space-y-2">
            <div className="flex justify-between text-xs text-zinc-400">
              <span>{jobStatus.message ?? `Frame ${jobStatus.progress} / ${jobStatus.total || "?"}`}</span>
              <span>{progress > 0 ? `${progress.toFixed(0)}%` : ""}</span>
            </div>
            <div className="h-2 bg-zinc-700 rounded-full overflow-hidden">
              <div
                className="h-full bg-indigo-500 rounded-full transition-all duration-300"
                style={{ width: `${progress}%` }}
              />
            </div>
            {jobStatus.total > 0 && (
              <p className="text-xs text-zinc-500">
                Frame {jobStatus.progress} of {jobStatus.total}
              </p>
            )}
          </div>
        ) : jobStatus.status === "error" ? (
          <div className="space-y-1">
            <p className="text-sm font-medium text-red-400">Detection failed</p>
            <p className="text-xs text-red-300 font-mono break-all">{jobStatus.message ?? "Unknown error"}</p>
          </div>
        ) : (
          <p className="text-sm text-zinc-500">Ready to run</p>
        )}
      </div>

      {/* Actions */}
      <div className="flex gap-3">
        {running ? (
          <button
            onClick={handleCancel}
            className="px-4 py-2 bg-zinc-700 hover:bg-zinc-600 text-white text-sm rounded-lg
                       transition-colors cursor-pointer"
          >
            Cancel
          </button>
        ) : (
          <button
            onClick={handleRun}
            disabled={!recording.eye_video}
            className="flex items-center gap-2 px-5 py-2 bg-indigo-600 hover:bg-indigo-500
                       disabled:opacity-40 disabled:cursor-not-allowed
                       text-white text-sm font-medium rounded-lg transition-colors cursor-pointer"
          >
            {done ? <RefreshCw className="w-4 h-4" /> : <Play className="w-4 h-4" />}
            {done ? "Re-run Detection" : "Run Detection"}
          </button>
        )}
        {done && (
          <button
            onClick={onDone}
            className="px-5 py-2 bg-zinc-800 hover:bg-zinc-700 text-white text-sm rounded-lg
                       transition-colors cursor-pointer"
          >
            Next: Calibrate →
          </button>
        )}
        {done && !running && (
          <button
            onClick={handleDelete}
            className="ml-auto flex items-center gap-2 px-4 py-2 text-red-400 hover:text-red-300
                       hover:bg-red-950/40 text-sm rounded-lg transition-colors cursor-pointer"
          >
            <Trash2 className="w-4 h-4" /> Delete data
          </button>
        )}
      </div>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between">
      <span className="text-zinc-500">{label}</span>
      <span className="text-white">{value}</span>
    </div>
  );
}

function NumberInput({
  label, value, onChange, disabled, step,
}: {
  label: string; value: number; onChange: (v: number) => void; disabled: boolean; step?: number;
}) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-xs text-zinc-400">{label}</span>
      <input
        type="number"
        step={step ?? 1}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        disabled={disabled}
        className="w-20 bg-zinc-800 text-white text-xs px-2 py-1 rounded border border-zinc-700
                   focus:border-indigo-500 outline-none disabled:opacity-50 text-right"
      />
    </div>
  );
}
