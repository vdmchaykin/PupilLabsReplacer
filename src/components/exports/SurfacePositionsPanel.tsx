import { useCallback, useEffect, useRef, useState } from "react";
import { AlertCircle, Grid3x3, Loader2 } from "lucide-react";
import { api } from "@/lib/api";
import { ExportSection } from "./ExportSection";

interface SurfaceStatus {
  status: "idle" | "running" | "done" | "error";
  progress: number;
  total: number;
  localized?: number;
  message?: string;
  has_file: boolean;
}

/**
 * Generates a Pupil-compatible surface_positions.csv for the recording: one row
 * per scene-camera frame with the AoI surface corners in scene pixels. The
 * surface is defined by the AoI editor's saved tags (backend re-detects on the
 * reference frame if a legacy state has none).
 */
export function SurfacePositionsPanel({
  recordingId, segmentId, hasSurface, onSave,
}: {
  recordingId: string;
  segmentId: string;
  hasSurface: boolean;
  onSave?: () => Promise<void>;
}) {
  const [status, setStatus] = useState<SurfaceStatus | null>(null);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const base = `/api/recordings/${recordingId}/aoi/surface-positions`;

  const fetchStatus = useCallback(async () => {
    try {
      const s = await api.get<SurfaceStatus>(base);
      setStatus(s);
      if (s.status !== "running" && pollRef.current) {
        clearInterval(pollRef.current);
        pollRef.current = null;
      }
    } catch { /* keep last status */ }
  }, [base]);

  // Reload status when the recording changes; clean up polling on unmount.
  useEffect(() => {
    setError(null);
    fetchStatus();
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recordingId]);

  const startPolling = () => {
    if (pollRef.current) clearInterval(pollRef.current);
    pollRef.current = setInterval(fetchStatus, 700);
  };

  const handleGenerate = async () => {
    setStarting(true);
    setError(null);
    try {
      if (onSave) await onSave();  // persist selected_tags so the backend can rebuild the surface
      await api.post(`${base}?segment_id=${encodeURIComponent(segmentId)}`, {});
      setStatus({ status: "running", progress: 0, total: 0, has_file: false });
      startPolling();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to start");
    } finally {
      setStarting(false);
    }
  };

  const handleCancel = async () => {
    try { await api.post(`${base}/cancel`, {}); } catch { /* ignore */ }
    fetchStatus();
  };

  const running = status?.status === "running";
  const pct = running && status.total > 0
    ? Math.min(100, Math.round((status.progress / status.total) * 100))
    : 0;

  return (
    <ExportSection
      title="Surface positions"
      Icon={Grid3x3}
      files={[{ name: "surface_positions.csv", ready: !!status?.has_file && !running }]}
    >
      {running ? (
        <>
          <div className="relative h-1.5 rounded-full bg-zinc-800 overflow-hidden">
            <div className="absolute inset-y-0 left-0 bg-indigo-500 transition-all" style={{ width: `${pct}%` }} />
          </div>
          <div className="flex items-center justify-between text-[10px] text-zinc-500">
            <span className="tabular-nums">{status.progress} / {status.total || "…"} frames</span>
            <button onClick={handleCancel} className="text-zinc-500 hover:text-red-400 cursor-pointer">
              Cancel
            </button>
          </div>
        </>
      ) : (
        <>
          {status?.status === "done" && typeof status.localized === "number" && status.total > 0 && (
            <p className="text-[10px] text-zinc-500">
              Localized in {status.localized}/{status.total} frames
            </p>
          )}

          {!hasSurface && (
            <p className="text-[10px] text-zinc-600">Define an AoI surface (3+ AprilTags) first</p>
          )}

          <button
            onClick={handleGenerate}
            disabled={!hasSurface || starting}
            className="flex items-center justify-center gap-1.5 px-3 py-1.5 w-full
                       bg-zinc-800 hover:bg-zinc-700 disabled:opacity-40 disabled:cursor-not-allowed
                       text-zinc-200 text-xs rounded-md transition-colors cursor-pointer"
          >
            {starting ? <Loader2 className="w-3 h-3 animate-spin" /> : <Grid3x3 className="w-3 h-3" />}
            {status?.has_file ? "Regenerate" : "Generate"}
          </button>
        </>
      )}

      {(error || status?.status === "error") && (
        <div className="flex items-start gap-1.5 text-[10px] text-red-400">
          <AlertCircle className="w-3 h-3 shrink-0 mt-px" />
          <span>{error || status?.message || "Generation failed"}</span>
        </div>
      )}
    </ExportSection>
  );
}
