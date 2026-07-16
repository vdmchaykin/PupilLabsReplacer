import { useEffect, useState } from "react";
import { Play, RefreshCw, CheckCircle2, Trash2 } from "lucide-react";
import type { FixationResult, GazeAnalysisState, RecordingMeta } from "@/types";

const API = "http://localhost:8765";

interface Props {
  recording: RecordingMeta;
  mappingDone: boolean;
  done: boolean;
  onDone: () => void;
  onDeleted: (state: GazeAnalysisState) => void;
}

// I-DT parameter defaults — must match the backend FixationRequest defaults.
const DEFAULTS = { max_dispersion_deg: 1.5, min_duration_ms: 80, max_gap_ms: 100 };

export function GazeFixationStep({ recording, mappingDone, done: initialDone, onDone, onDeleted }: Props) {
  const [running, setRunning] = useState(false);
  const [done, setDone] = useState(initialDone);
  const [result, setResult] = useState<FixationResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [params, setParams] = useState(DEFAULTS);

  // Load the last run's stats (and the params it used) when arriving on an
  // already-computed recording.
  useEffect(() => {
    if (!initialDone) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`${API}/api/recordings/${recording.id}/gaze/fixations/result`);
        if (!res.ok) return;
        const data: FixationResult | null = await res.json();
        if (!cancelled && data) {
          setResult(data);
          setParams({
            max_dispersion_deg: data.max_dispersion_deg,
            min_duration_ms: data.min_duration_ms,
            max_gap_ms: data.max_gap_ms,
          });
        }
      } catch {
        /* leave result null — falls back to the "already done" notice */
      }
    })();
    return () => { cancelled = true; };
  }, [recording.id, initialDone]);

  const handleRun = async () => {
    setRunning(true);
    setError(null);
    try {
      const res = await fetch(`${API}/api/recordings/${recording.id}/gaze/fixations`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(params),
      });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        throw new Error(d.detail ?? `HTTP ${res.status}`);
      }
      const data: FixationResult = await res.json();
      setResult(data);
      setDone(true);
      onDone();
    } catch (e) {
      setError(String(e));
    } finally {
      setRunning(false);
    }
  };

  const handleDelete = async () => {
    if (!confirm("Delete fixation results for this recording?")) return;
    try {
      const res = await fetch(`${API}/api/recordings/${recording.id}/gaze/data/fixations`, { method: "DELETE" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const state: GazeAnalysisState = await res.json();
      setDone(false);
      setResult(null);
      setError(null);
      onDeleted(state);
    } catch (e) {
      setError(String(e));
    }
  };

  return (
    <div className="p-8 max-w-3xl mx-auto space-y-8">
      <div>
        <h2 className="text-lg font-semibold text-white">Step 4 — Fixations</h2>
        <p className="text-sm text-zinc-400 mt-1">
          Detect fixations from the mapped gaze with a dispersion algorithm (I-DT). Fixations are
          found in scene-camera pixels and annotated with surface coordinates when the gaze falls
          on the paper.
        </p>
      </div>

      {!mappingDone && (
        <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-5">
          <p className="text-xs text-amber-400">⚠ No gaze mapping yet — run Step 3 first.</p>
        </div>
      )}

      {/* Parameters */}
      <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-5 space-y-5">
        <p className="text-xs text-zinc-500 uppercase tracking-wider">Parameters</p>
        <ParamSlider
          label="Max dispersion"
          unit="°"
          min={0.5} max={3} step={0.1}
          value={params.max_dispersion_deg}
          onChange={(v) => setParams((p) => ({ ...p, max_dispersion_deg: v }))}
          hint="Spatial spread allowed within one fixation (~15.5 px/° on the scene camera)."
        />
        <ParamSlider
          label="Min duration"
          unit="ms"
          min={40} max={300} step={10}
          value={params.min_duration_ms}
          onChange={(v) => setParams((p) => ({ ...p, min_duration_ms: v }))}
          hint="Shorter candidate windows are discarded (at 30 fps a sample is ~33 ms)."
        />
        <ParamSlider
          label="Max gap"
          unit="ms"
          min={33} max={300} step={10}
          value={params.max_gap_ms}
          onChange={(v) => setParams((p) => ({ ...p, max_gap_ms: v }))}
          hint="A longer gap (blink / tracking loss) ends the current fixation."
        />
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
            <span className="text-sm font-medium">Fixation detection complete</span>
          </div>

          <div className="grid grid-cols-3 gap-4">
            <Stat label="Fixations" value={String(result.n_fixations)} />
            <Stat label="Median duration" value={`${result.median_duration_ms.toFixed(0)} ms`} />
            <Stat label="Mean duration" value={`${result.mean_duration_ms.toFixed(0)} ms`} />
            <Stat label="Longest" value={`${result.max_duration_ms.toFixed(0)} ms`} />
            <Stat label="Time fixating" value={`${result.pct_time_fixating.toFixed(0)}%`} />
            <Stat label="On surface" value={`${result.pct_on_surface.toFixed(0)}%`} />
          </div>

          <p className="text-xs text-zinc-500">
            Scene-space detection has no head-motion compensation, so long fixations may fragment
            while the head turns — expect more, shorter fixations than Pupil Cloud.
          </p>
        </div>
      )}

      {done && !result && (
        <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-5">
          <div className="flex items-center gap-2 text-emerald-400">
            <CheckCircle2 className="w-5 h-5" />
            <span className="text-sm">Fixations already computed. Re-run to see stats.</span>
          </div>
        </div>
      )}

      {/* Actions */}
      <div className="flex gap-3">
        <button
          onClick={handleRun}
          disabled={running || !mappingDone}
          className="flex items-center gap-2 px-5 py-2 bg-indigo-600 hover:bg-indigo-500
                     disabled:opacity-40 disabled:cursor-not-allowed
                     text-white text-sm font-medium rounded-lg transition-colors cursor-pointer"
        >
          {running ? (
            <><RefreshCw className="w-4 h-4 animate-spin" /> Computing…</>
          ) : (
            <><Play className="w-4 h-4" />{done ? "Re-run Detection" : "Compute Fixations"}</>
          )}
        </button>
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

function ParamSlider({
  label, unit, min, max, step, value, onChange, hint,
}: {
  label: string; unit: string; min: number; max: number; step: number;
  value: number; onChange: (v: number) => void; hint: string;
}) {
  return (
    <div>
      <div className="flex items-center justify-between text-sm">
        <span className="text-zinc-300">{label}</span>
        <span className="font-medium text-white tabular-nums">{value} {unit}</span>
      </div>
      <input
        type="range"
        min={min} max={max} step={step} value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="w-full mt-2 accent-indigo-500 cursor-pointer"
      />
      <p className="text-xs text-zinc-500 mt-1">{hint}</p>
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
