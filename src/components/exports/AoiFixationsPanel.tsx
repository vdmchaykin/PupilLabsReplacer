import { useCallback, useEffect, useState } from "react";
import { AlertCircle, Loader2, Target } from "lucide-react";
import { api } from "@/lib/api";
import { ExportSection } from "./ExportSection";

interface MetricsStatus {
  has_fixations: boolean;
  n_segments: number;
  n_areas: number;
  has_file: boolean;
}

interface MetricsResult {
  n_segments: number;
  n_areas: number;
  n_areas_fixated: number;
  n_fixations: number;
  n_aoi_fixations: number;
}

/**
 * Generates the Pupil-compatible aoi_fixations.csv (one row per fixation per AoI
 * it landed in) and aoi_metrics.csv (per-AoI fixation counts, durations and time
 * to first fixation). Needs fixations from the Gaze section plus AoI shapes drawn
 * in the AoI section.
 *
 * One export covers every segment at once — each row carries its "segment id" —
 * so this panel is deliberately independent of the active segment tab.
 */
export function AoiFixationsPanel({ recordingId }: { recordingId: string }) {
  const [status, setStatus] = useState<MetricsStatus | null>(null);
  const [result, setResult] = useState<MetricsResult | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const base = `/api/recordings/${recordingId}/aoi/aoi-metrics`;

  const fetchStatus = useCallback(async () => {
    try {
      setStatus(await api.get<MetricsStatus>(base));
    } catch { /* keep last status */ }
  }, [base]);

  useEffect(() => {
    setError(null);
    setResult(null);
    fetchStatus();
  }, [fetchStatus]);

  const handleGenerate = async () => {
    setRunning(true);
    setError(null);
    try {
      setResult(await api.post<MetricsResult>(base, {}));
      await fetchStatus();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to generate");
    } finally {
      setRunning(false);
    }
  };

  const noFixations = status !== null && !status.has_fixations;
  const noAreas = status !== null && status.n_areas === 0;
  const blocked = noFixations || noAreas;

  const hint = noFixations
    ? "Run fixation detection in the Gaze section first"
    : noAreas
      ? "Draw areas of interest in the AoI section first"
      : null;

  const ready = !!status?.has_file;

  return (
    <ExportSection
      title="AoI Fixations"
      Icon={Target}
      files={[
        { name: "aoi_fixations.csv", ready },
        { name: "aoi_metrics.csv", ready },
      ]}
    >
      {result && (
        <p className="text-[10px] text-zinc-500">
          {result.n_aoi_fixations} fixations mapped onto {result.n_areas_fixated}/{result.n_areas} areas
          {" "}across {result.n_segments} segment{result.n_segments === 1 ? "" : "s"}
        </p>
      )}

      {!result && status !== null && !blocked && (
        <p className="text-[10px] text-zinc-500">
          {status.n_areas} areas across {status.n_segments} segment{status.n_segments === 1 ? "" : "s"}
        </p>
      )}

      {hint && <p className="text-[10px] text-zinc-600">{hint}</p>}

      <button
        onClick={handleGenerate}
        disabled={blocked || running || status === null}
        className="flex items-center justify-center gap-1.5 px-3 py-1.5 w-full
                   bg-zinc-800 hover:bg-zinc-700 disabled:opacity-40 disabled:cursor-not-allowed
                   text-zinc-200 text-xs rounded-md transition-colors cursor-pointer"
      >
        {running ? <Loader2 className="w-3 h-3 animate-spin" /> : <Target className="w-3 h-3" />}
        {ready ? "Regenerate" : "Generate"}
      </button>

      {error && (
        <div className="flex items-start gap-1.5 text-[10px] text-red-400">
          <AlertCircle className="w-3 h-3 shrink-0 mt-px" />
          <span>{error}</span>
        </div>
      )}
    </ExportSection>
  );
}
