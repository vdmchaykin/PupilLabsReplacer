import { useEffect, useState } from "react";
import { ScanEye, ChevronRight } from "lucide-react";
import { api } from "@/lib/api";
import { formatDuration, formatDate } from "@/lib/utils";
import type { RecordingMeta, GazeStep, GazeAnalysisState } from "@/types";
import { GazeDetectStep } from "@/components/gaze/GazeDetectStep";
import { GazeCalibrateStep } from "@/components/gaze/GazeCalibrateStep";
import { GazeMapStep } from "@/components/gaze/GazeMapStep";
import { GazeFixationStep } from "@/components/gaze/GazeFixationStep";
import { RecordingThumbnail } from "@/components/player/RecordingThumbnail";

const STEPS: { id: GazeStep; label: string; short: string }[] = [
  { id: "detect", label: "Detect Pupils", short: "Pupils" },
  { id: "calibrate", label: "Calibrate", short: "Calibrate" },
  { id: "map", label: "Map Gaze", short: "Map" },
  { id: "fixations", label: "Fixations", short: "Fixations" },
];

// Which analysis-state flag marks a step complete.
const STEP_DONE_FLAG: Record<GazeStep, keyof GazeAnalysisState> = {
  detect: "pupils_done",
  calibrate: "calibration_done",
  map: "mapping_done",
  fixations: "fixations_done",
};

export function GazePage({ onOpenPlayer, initialRecording }: { onOpenPlayer: (id: string) => void; initialRecording?: RecordingMeta }) {
  const [recordings, setRecordings] = useState<RecordingMeta[]>([]);
  const [selected, setSelected] = useState<RecordingMeta | null>(initialRecording ?? null);
  const [step, setStep] = useState<GazeStep>("detect");
  const [analysisState, setAnalysisState] = useState<GazeAnalysisState>({
    pupils_done: false,
    calibration_done: false,
    mapping_done: false,
    fixations_done: false,
    calibration_points: [],
  });
  const [loadingRecs, setLoadingRecs] = useState(true);
  // Gate the wizard until the recording's analysis state has loaded. Without
  // this, the "detect" step (the default) mounts before /gaze/state resolves and
  // its own detect-status check fires onDone → setStep("calibrate"), overriding
  // the correct routing on the first deep-link open.
  const [stateLoading, setStateLoading] = useState<boolean>(!!initialRecording);

  useEffect(() => {
    api.get<RecordingMeta[]>("/api/recordings")
      .then(setRecordings)
      .finally(() => setLoadingRecs(false));
  }, []);

  useEffect(() => {
    if (initialRecording) fetchAnalysisState(initialRecording.id);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const fetchAnalysisState = async (id: string) => {
    setStateLoading(true);
    try {
      const state = await api.get<GazeAnalysisState>(`/api/recordings/${id}/gaze/state`);
      setAnalysisState(state);
      if (state.fixations_done) setStep("fixations");
      else if (state.mapping_done) setStep("map");
      else if (state.calibration_done) setStep("map");
      else if (state.pupils_done) setStep("calibrate");
      else setStep("detect");
    } catch {
      setAnalysisState({ pupils_done: false, calibration_done: false, mapping_done: false, fixations_done: false, calibration_points: [] });
      setStep("detect");
    } finally {
      setStateLoading(false);
    }
  };

  const handleSelectRecording = (rec: RecordingMeta) => {
    setSelected(rec);
    fetchAnalysisState(rec.id);
  };

  // Refresh analysis flags after a stage's data is deleted, without changing
  // which step the user is currently viewing.
  const applyState = (state: GazeAnalysisState) => setAnalysisState(state);

  if (!selected) {
    return (
      <div className="flex h-full">
        <div className="w-80 border-r border-zinc-800 flex flex-col">
          <div className="flex-1 overflow-auto">
            {loadingRecs ? (
              <p className="text-zinc-500 text-xs p-4">Loading…</p>
            ) : recordings.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-12 text-zinc-600">
                <ScanEye className="w-8 h-8 mb-2 opacity-30" />
                <p className="text-xs">No recordings yet</p>
              </div>
            ) : (
              recordings.map((rec) => (
                <button
                  key={rec.id}
                  onClick={() => handleSelectRecording(rec)}
                  className="w-full flex items-center gap-3 px-4 py-3 text-left
                             border-b border-zinc-800/50 hover:bg-zinc-900 transition-colors
                             group cursor-pointer"
                >
                  <RecordingThumbnail recordingId={rec.id} />
                  <div className="flex-1 min-w-0">
                    <p className="text-sm text-white truncate">{rec.name}</p>
                    <p className="text-xs text-zinc-500">
                      {rec.wearer_name} · {formatDuration(rec.duration_sec)} · {formatDate(rec.start_time)}
                    </p>
                  </div>
                  <ChevronRight className="w-3.5 h-3.5 text-zinc-600" />
                </button>
              ))
            )}
          </div>
        </div>
        <div className="flex-1 flex items-center justify-center text-zinc-600">
          <p className="text-sm">Select a recording to start gaze analysis</p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      {/* Header with back + step indicator */}
      <div className="flex items-center gap-4 px-6 py-4 border-b border-zinc-800">
        <button
          onClick={() => setSelected(null)}
          className="text-xs text-zinc-400 hover:text-white transition-colors cursor-pointer"
        >
          ← All Recordings
        </button>
        <span className="text-zinc-700">|</span>
        <span className="text-sm font-medium text-white">{selected.name}</span>
        <div className="flex-1" />

        {/* Step indicator */}
        <div className="flex items-center gap-0">
          {STEPS.map((s, i) => {
            // A stage is "done" purely from its completion flag, independent of
            // which step is currently open — so a finished stage stays green
            // even after navigating elsewhere.
            const done = !!analysisState[STEP_DONE_FLAG[s.id]];
            const current = s.id === step;
            return (
              <div key={s.id} className="flex items-center">
                <button
                  onClick={() => setStep(s.id)}
                  className={`flex items-center gap-2 px-3 py-1.5 rounded-lg text-xs font-medium
                              transition-colors cursor-pointer
                              ${current ? "bg-indigo-600 text-white" : done ? "text-emerald-400 hover:bg-zinc-800" : "text-zinc-500 hover:bg-zinc-800"}`}
                >
                  {/* Green circle (no checkmark, keeps the step number)
                      whenever the stage is complete. Number colour is set inline
                      because light theme remaps `.text-white` to dark slate. */}
                  <span
                    style={{ color: "#fff" }}
                    className={`w-5 h-5 rounded-full flex items-center justify-center text-[10px] font-bold
                    ${done ? "bg-emerald-500" : current ? "bg-indigo-400" : "bg-zinc-700"}`}
                  >
                    {i + 1}
                  </span>
                  {s.short}
                </button>
                {i < STEPS.length - 1 && (
                  <div className={`w-8 h-px mx-1 ${done ? "bg-emerald-600" : "bg-zinc-700"}`} />
                )}
              </div>
            );
          })}
        </div>
      </div>

      {/* Step content */}
      <div className="flex-1 overflow-auto">
        {stateLoading && (
          <div className="p-8 text-sm text-zinc-500">Loading analysis state…</div>
        )}
        {!stateLoading && step === "detect" && (
          <GazeDetectStep
            recording={selected}
            done={analysisState.pupils_done}
            onDone={() => {
              setAnalysisState((s) => ({ ...s, pupils_done: true }));
              setStep("calibrate");
            }}
            onDeleted={applyState}
          />
        )}
        {!stateLoading && step === "calibrate" && (
          <GazeCalibrateStep
            recording={selected}
            existingPoints={analysisState.calibration_points}
            done={analysisState.calibration_done}
            onDone={(points) => {
              setAnalysisState((s) => ({ ...s, calibration_done: true, calibration_points: points }));
              setStep("map");
            }}
            onDeleted={applyState}
          />
        )}
        {!stateLoading && step === "map" && (
          <GazeMapStep
            recording={selected}
            calibrationPoints={analysisState.calibration_points}
            done={analysisState.mapping_done}
            onDone={() => setAnalysisState((s) => ({ ...s, mapping_done: true }))}
            onDeleted={applyState}
            onOpenPlayer={onOpenPlayer}
          />
        )}
        {!stateLoading && step === "fixations" && (
          <GazeFixationStep
            recording={selected}
            mappingDone={analysisState.mapping_done}
            done={analysisState.fixations_done}
            onDone={() => setAnalysisState((s) => ({ ...s, fixations_done: true }))}
            onDeleted={applyState}
          />
        )}
      </div>
    </div>
  );
}
