import { useState } from "react";
import { Play, RefreshCw, CheckCircle2, PlayCircle } from "lucide-react";
import type { CalibrationPoint, RecordingMeta } from "@/types";

const API = "http://localhost:8765";

interface ResidualRow {
  point_id: number;
  true_x: number;
  true_y: number;
  pred_x: number;
  pred_y: number;
  error_px: number;
}

interface MapResult {
  mean_rmse: number;
  frames_with_gaze: number;
  frames_on_paper: number;
  total_frames: number;
  residuals: ResidualRow[];
}

interface Props {
  recording: RecordingMeta;
  calibrationPoints: CalibrationPoint[];
  done: boolean;
  onDone: () => void;
  onOpenPlayer: (id: string) => void;
}

export function GazeMapStep({ recording, calibrationPoints, done: initialDone, onDone, onOpenPlayer }: Props) {
  const [running, setRunning] = useState(false);
  const [done, setDone] = useState(initialDone);
  const [result, setResult] = useState<MapResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const handleRun = async () => {
    setRunning(true);
    setError(null);
    try {
      const res = await fetch(`${API}/api/recordings/${recording.id}/gaze/map`, {
        method: "POST",
      });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        throw new Error(d.detail ?? `HTTP ${res.status}`);
      }
      const data: MapResult = await res.json();
      setResult(data);
      setDone(true);
      onDone();
    } catch (e) {
      setError(String(e));
    } finally {
      setRunning(false);
    }
  };

  const pct = (n: number, d: number) => d > 0 ? ((n / d) * 100).toFixed(1) + "%" : "—";

  return (
    <div className="p-8 max-w-3xl mx-auto space-y-8">
      <div>
        <h2 className="text-lg font-semibold text-white">Step 3 — Gaze Mapping</h2>
        <p className="text-sm text-zinc-400 mt-1">
          Train polynomial regression on calibration points and predict gaze for all frames.
          
        </p>
      </div>

      {/* Calibration summary */}
      <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-5 space-y-2">
        <p className="text-xs text-zinc-500 uppercase tracking-wider">Calibration Summary</p>
        <div className="flex items-center gap-6 text-sm">
          <span className="text-zinc-400">Points collected:</span>
          <span className={`font-medium ${calibrationPoints.length === 9 ? "text-emerald-400" : "text-amber-400"}`}>
            {calibrationPoints.length} / 9
          </span>
        </div>
        {calibrationPoints.length === 0 && (
          <p className="text-xs text-amber-400">⚠ No calibration points — go back to Step 2</p>
        )}
      </div>

      {/* Error */}
      {error && (
        <div className="px-4 py-3 bg-red-950 border border-red-800 rounded-lg text-red-300 text-sm">
          {error}
        </div>
      )}

      {/* Results */}
      {done && result && (
        <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-5 space-y-4">
          <div className="flex items-center gap-2 text-emerald-400">
            <CheckCircle2 className="w-5 h-5" />
            <span className="text-sm font-medium">Mapping complete</span>
          </div>

          <div className="grid grid-cols-3 gap-4">
            <Stat label="Mean RMSE" value={`${result.mean_rmse.toFixed(1)} px`} />
            <Stat label="Frames with gaze" value={pct(result.frames_with_gaze, result.total_frames)} />
            <Stat label="Frames on paper" value={pct(result.frames_on_paper, result.total_frames)} />
          </div>

          {result.residuals.length > 0 && (
            <div>
              <p className="text-xs text-zinc-500 uppercase tracking-wider mb-2">Residuals per point</p>
              <table className="w-full text-xs">
                <thead>
                  <tr className="text-zinc-500 border-b border-zinc-800">
                    <th className="text-left py-1.5 font-normal">Point</th>
                    <th className="text-right py-1.5 font-normal">True</th>
                    <th className="text-right py-1.5 font-normal">Predicted</th>
                    <th className="text-right py-1.5 font-normal">Error</th>
                  </tr>
                </thead>
                <tbody>
                  {result.residuals.map((r) => (
                    <tr key={r.point_id} className="border-b border-zinc-800/50 text-zinc-300">
                      <td className="py-1.5">{r.point_id}</td>
                      <td className="py-1.5 text-right">{r.true_x.toFixed(0)}, {r.true_y.toFixed(0)}</td>
                      <td className="py-1.5 text-right">{r.pred_x.toFixed(0)}, {r.pred_y.toFixed(0)}</td>
                      <td className={`py-1.5 text-right font-medium
                        ${r.error_px < 10 ? "text-emerald-400" : r.error_px < 25 ? "text-amber-400" : "text-red-400"}`}>
                        {r.error_px.toFixed(1)} px
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {done && !result && (
        <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-5">
          <div className="flex items-center gap-2 text-emerald-400">
            <CheckCircle2 className="w-5 h-5" />
            <span className="text-sm">Gaze mapping already done. Re-run to see residuals.</span>
          </div>
        </div>
      )}

      {/* Actions */}
      <div className="flex gap-3">
        <button
          onClick={handleRun}
          disabled={running || calibrationPoints.length === 0}
          className="flex items-center gap-2 px-5 py-2 bg-indigo-600 hover:bg-indigo-500
                     disabled:opacity-40 disabled:cursor-not-allowed
                     text-white text-sm font-medium rounded-lg transition-colors cursor-pointer"
        >
          {running ? (
            <><RefreshCw className="w-4 h-4 animate-spin" /> Running…</>
          ) : (
            <><Play className="w-4 h-4" />{done ? "Re-run Mapping" : "Run Gaze Mapping"}</>
          )}
        </button>
        {done && (
          <button
            onClick={() => onOpenPlayer(recording.id)}
            className="flex items-center gap-2 px-5 py-2 bg-emerald-700 hover:bg-emerald-600
                       text-white text-sm font-medium rounded-lg transition-colors cursor-pointer"
          >
            <PlayCircle className="w-4 h-4" />
            Open in Player
          </button>
        )}
      </div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="bg-zinc-800 rounded-lg p-3">
      <p className="text-xs text-zinc-500">{label}</p>
      <p className="text-lg font-semibold text-white mt-1">{value}</p>
    </div>
  );
}
