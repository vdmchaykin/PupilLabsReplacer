import { useState, useEffect, useRef } from "react";
import { Play, RefreshCw, CheckCircle2 } from "lucide-react";
import type { RecordingMeta } from "@/types";

const API = "http://localhost:8765";

interface Props {
  recording: RecordingMeta;
  done: boolean;
  onDone: () => void;
}

interface DetectStatus {
  status: "idle" | "running" | "done" | "error";
  progress: number;
  total: number;
  mean_confidence: number;
  message?: string;
}

export function GazeDetectStep({ recording, done: initialDone, onDone }: Props) {
  const [cannyLow, setCannyLow] = useState(50);
  const [cannyHigh, setCannyHigh] = useState(100);
  const [minArea, setMinArea] = useState(250);
  const [roiSize, setRoiSize] = useState(30);

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
          canny_low: cannyLow,
          canny_high: cannyHigh,
          min_ellipse_area: minArea,
          heatmap_roi_size: roiSize,
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
          <p className="text-xs text-zinc-500 uppercase tracking-wider">Configuration</p>
          <div className="space-y-2">
            <NumberInput label="Canny low" value={cannyLow} onChange={setCannyLow} disabled={running} />
            <NumberInput label="Canny high" value={cannyHigh} onChange={setCannyHigh} disabled={running} />
            <NumberInput label="Min ellipse area" value={minArea} onChange={setMinArea} disabled={running} />
            <NumberInput label="ROI size (px)" value={roiSize} onChange={setRoiSize} disabled={running} />
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
  label, value, onChange, disabled,
}: {
  label: string; value: number; onChange: (v: number) => void; disabled: boolean;
}) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-xs text-zinc-400">{label}</span>
      <input
        type="number"
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        disabled={disabled}
        className="w-20 bg-zinc-800 text-white text-xs px-2 py-1 rounded border border-zinc-700
                   focus:border-indigo-500 outline-none disabled:opacity-50 text-right"
      />
    </div>
  );
}
