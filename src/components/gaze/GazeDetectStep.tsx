import { useState, useEffect, useRef } from "react";
import { Play, RefreshCw, CheckCircle2, Trash2, ChevronDown, Eye } from "lucide-react";
import { confirmDialog } from "@/components/ConfirmDialog";
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

interface EyeStages {
  roi_png: string | null;
  mask_png: string | null;
  overlay_png: string | null;
  reason: string;
  A: number | null;
  B: number | null;
  angle: number | null;
  confidence: number | null;
}

interface DebugPreview {
  frame: number;
  total_frames: number;
  left: EyeStages;
  right: EyeStages;
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
  const [configOpen, setConfigOpen] = useState(false);

  // Edge-based (fallback) detector knobs — mirror EdgeDetectorConfig defaults
  const [edgeCannyLow, setEdgeCannyLow] = useState(30);
  const [edgeCannyHigh, setEdgeCannyHigh] = useState(90);
  const [edgeSpecThr, setEdgeSpecThr] = useState(220);
  const [edgeSpecDilate, setEdgeSpecDilate] = useState(3);
  const [edgeSplitMinLen, setEdgeSplitMinLen] = useState(10);
  const [edgeSplitMaxJump, setEdgeSplitMaxJump] = useState(6);
  const [edgeSplitCornerDeg, setEdgeSplitCornerDeg] = useState(75);
  const [edgeMaxSegStraightness, setEdgeMaxSegStraightness] = useState(0.92);
  const [edgeCircleFitMaxRms, setEdgeCircleFitMaxRms] = useState(0.8);
  const [edgeCircleFitMinRadius, setEdgeCircleFitMinRadius] = useState(6);
  const [edgeCircleFitMaxRadius, setEdgeCircleFitMaxRadius] = useState(15);
  const [edgeMaxCenterDist, setEdgeMaxCenterDist] = useState(0.9);
  const [edgeSupportDistPx, setEdgeSupportDistPx] = useState(2);
  const [edgeSupportMinFrac, setEdgeSupportMinFrac] = useState(0.2);
  const [edgeHeatmapPriorWeight, setEdgeHeatmapPriorWeight] = useState(0.3);
  const [edgeConfigOpen, setEdgeConfigOpen] = useState(false);

  // Debug preview panel: "frame" = single-frame floodfill stages (tuning),
  // "stream" = live full-pipeline video (all stages, both eyes).
  const [previewOpen, setPreviewOpen] = useState(false);
  const [previewMode, setPreviewMode] = useState<"frame" | "stream">("frame");
  const [previewFrame, setPreviewFrame] = useState(0);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [preview, setPreview] = useState<DebugPreview | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);

  // Live stream (MJPEG) state
  const [streamPlaying, setStreamPlaying] = useState(false);
  const [streamStart, setStreamStart] = useState(0);
  const [streamNonce, setStreamNonce] = useState(0);

  // Detector config shared by single-frame preview and the live stream.
  const configParams = () => ({
    heatmap_roi_size: roiSize,
    floodfill_lo_diff: loDiff,
    floodfill_hi_diff: hiDiff,
    floodfill_blur_ksize: blurKsize,
    floodfill_min_area: minArea,
    floodfill_min_fill_frac: minFillFrac,
    floodfill_max_aspect: maxAspect,
    floodfill_seed_search: seedSearch,
    floodfill_lash_open_ksize: lashOpenKsize,
    edge_canny_low: edgeCannyLow,
    edge_canny_high: edgeCannyHigh,
    edge_spec_thr: edgeSpecThr,
    edge_spec_dilate: edgeSpecDilate,
    edge_split_min_len: edgeSplitMinLen,
    edge_split_max_jump: edgeSplitMaxJump,
    edge_split_corner_deg: edgeSplitCornerDeg,
    edge_max_seg_straightness: edgeMaxSegStraightness,
    edge_circle_fit_max_rms: edgeCircleFitMaxRms,
    edge_circle_fit_min_radius: edgeCircleFitMinRadius,
    edge_circle_fit_max_radius: edgeCircleFitMaxRadius,
    edge_max_center_dist: edgeMaxCenterDist,
    edge_support_dist_px: edgeSupportDistPx,
    edge_support_min_frac: edgeSupportMinFrac,
    edge_heatmap_prior_weight: edgeHeatmapPriorWeight,
  });

  const streamUrl =
    `${API}/api/recordings/${recording.id}/gaze/detect-stream?` +
    new URLSearchParams({
      start: String(streamStart),
      ...Object.fromEntries(Object.entries(configParams()).map(([k, v]) => [k, String(v)])),
      _n: String(streamNonce),
    }).toString();

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

  // Start streaming: bump the nonce so the <img> reconnects with the current
  // params/frame. Stop simply unmounts the <img>, which closes the connection
  // and lets the backend generator release the video.
  const handleStreamStart = () => { setStreamNonce((n) => n + 1); setStreamPlaying(true); };
  const handleStreamStop = () => setStreamPlaying(false);

  const handleDelete = async () => {
    if (!(await confirmDialog({ title: "Delete pupil detection", message: "Delete pupil detection data? This also clears calibration and mapping for this recording." }))) return;
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

  const handlePreview = async () => {
    setPreviewLoading(true);
    setPreviewError(null);
    try {
      const res = await fetch(`${API}/api/recordings/${recording.id}/gaze/detect-debug`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...configParams(), frame: previewFrame }),
      });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        throw new Error(d.detail ?? `HTTP ${res.status}`);
      }
      const data: DebugPreview = await res.json();
      setPreview(data);
      setPreviewFrame(data.frame);
    } catch (e) {
      setPreviewError(String(e instanceof Error ? e.message : e));
    } finally {
      setPreviewLoading(false);
    }
  };

  const running = jobStatus.status === "running";
  const done = jobStatus.status === "done";
  const progress = jobStatus.total > 0 ? (jobStatus.progress / jobStatus.total) * 100 : 0;

  return (
    <div className="p-8 max-w-5xl mx-auto space-y-8">
      <div>
        <h2 className="text-lg font-semibold text-white">Step 1 — Pupil Detection</h2>
        <p className="text-sm text-zinc-400 mt-1">
          Detect pupil positions using HeatmapNet ROI + edge detection and ellipse fitting.
        </p>
      </div>

      {/* Recording info */}
      <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-5">
        <p className="text-xs text-zinc-500 uppercase tracking-wider mb-3">Recording</p>
        <div className="flex flex-wrap gap-x-10 gap-y-2 text-sm">
          <Row label="Name" value={recording.name} />
          <Row label="Wearer" value={recording.wearer_name ?? "—"} />
          <Row label="Eye video" value={recording.eye_video ? "✅ present" : "❌ missing"} />
        </div>
      </div>

      {/* Configurators — floodfill (primary) beside edge-based (fallback) */}
      <div className="grid grid-cols-2 gap-6 items-start">
        {/* Floodfill config — collapsible */}
        <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-5 space-y-3">
          <button
            onClick={() => setConfigOpen((v) => !v)}
            className="w-full flex items-center justify-between text-xs text-zinc-500 uppercase
                       tracking-wider hover:text-zinc-300 transition-colors cursor-pointer"
          >
            <span>Floodfill configuration <span className="text-zinc-600 normal-case">— primary</span></span>
            <ChevronDown
              className={`w-4 h-4 transition-transform ${configOpen ? "rotate-180" : ""}`}
            />
          </button>
          {configOpen && (
            <div className="space-y-2">
              <NumberInput label="ROI size (px)" value={roiSize} onChange={setRoiSize} disabled={running}
                hint="Size of the square crop taken around the HeatmapNet pupil-centre estimate; the detector only searches inside this ROI." />
              <NumberInput label="Lo diff" value={loDiff} onChange={setLoDiff} disabled={running}
                hint="Floodfill lower tolerance: how much darker than the seed a neighbouring pixel may be and still be absorbed into the pupil region. Higher = fill grows more easily." />
              <NumberInput label="Hi diff" value={hiDiff} onChange={setHiDiff} disabled={running}
                hint="Floodfill upper tolerance: how much brighter than the seed a neighbouring pixel may be and still be absorbed. Higher = fill leaks into brighter areas." />
              <NumberInput label="Blur ksize" value={blurKsize} onChange={setBlurKsize} disabled={running}
                hint="Gaussian blur kernel applied before choosing the seed so the darkest point lands inside the pupil rather than on noise (0 = off, odd values only)." />
              <NumberInput label="Min area" value={minArea} onChange={setMinArea} disabled={running}
                hint="Minimum area (px²) of the filled blob for it to be accepted as a pupil; smaller blobs are rejected as noise." />
              <NumberInput label="Min fill frac" value={minFillFrac} onChange={setMinFillFrac} disabled={running} step={0.05}
                hint="Minimum ratio of filled area to the fitted-ellipse area. Low values mean the blob is not ellipse-shaped, so the detection is rejected." />
              <NumberInput label="Max aspect" value={maxAspect} onChange={setMaxAspect} disabled={running} step={0.1}
                hint="Maximum allowed ellipse aspect ratio (long/short axis). Above this the fit is rejected as too elongated to be a pupil." />
              <NumberInput label="Seed search (px)" value={seedSearch} onChange={setSeedSearch} disabled={running}
                hint="Radius around the HeatmapNet centre within which the darkest pixel is searched to seed the floodfill." />
              <NumberInput label="Lash open ksize" value={lashOpenKsize} onChange={setLashOpenKsize} disabled={running}
                hint="Grayscale morphological-opening kernel that erases bright eyelash stripes before filling, so they don't cut the pupil apart (0 = off)." />
            </div>
          )}
        </div>

        {/* Edge-based config — collapsible */}
        <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-5 space-y-3">
          <button
            onClick={() => setEdgeConfigOpen((v) => !v)}
            className="w-full flex items-center justify-between text-xs text-zinc-500 uppercase
                       tracking-wider hover:text-zinc-300 transition-colors cursor-pointer"
          >
            <span>Edge-based configuration <span className="text-zinc-600 normal-case">— fallback</span></span>
            <ChevronDown
              className={`w-4 h-4 transition-transform ${edgeConfigOpen ? "rotate-180" : ""}`}
            />
          </button>
          {edgeConfigOpen && (
            <div className="space-y-2">
              <NumberInput label="Canny low" value={edgeCannyLow} onChange={setEdgeCannyLow} disabled={running}
                hint="Lower hysteresis threshold for Canny edge detection in the ROI. Lower = more (weaker) edges kept." />
              <NumberInput label="Canny high" value={edgeCannyHigh} onChange={setEdgeCannyHigh} disabled={running}
                hint="Upper hysteresis threshold for Canny edge detection. Only edges above it start a contour; those between low and high are kept if connected." />
              <NumberInput label="Spec thr" value={edgeSpecThr} onChange={setEdgeSpecThr} disabled={running}
                hint="Brightness threshold above which pixels are treated as specular highlights (IR reflections) and removed from the edge map." />
              <NumberInput label="Spec dilate" value={edgeSpecDilate} onChange={setEdgeSpecDilate} disabled={running}
                hint="Dilation applied to the specular-highlight mask so edges around each reflection are also removed." />
              <NumberInput label="Split min len" value={edgeSplitMinLen} onChange={setEdgeSplitMinLen} disabled={running}
                hint="Minimum length (points) of a contour segment kept after a contour is split at corners." />
              <NumberInput label="Split max jump" value={edgeSplitMaxJump} onChange={setEdgeSplitMaxJump} disabled={running} step={0.5}
                hint="Maximum gap (px) allowed between consecutive contour points before the segment is broken in two." />
              <NumberInput label="Split corner °" value={edgeSplitCornerDeg} onChange={setEdgeSplitCornerDeg} disabled={running}
                hint="Turn angle (degrees) above which a contour is cut into separate segments, breaking eyelash/lid corners off the pupil arc." />
              <NumberInput label="Max straightness" value={edgeMaxSegStraightness} onChange={setEdgeMaxSegStraightness} disabled={running} step={0.01}
                hint="Chord/arc ratio ceiling. Segments straighter than this (≈1.0 = a line) are discarded as eyelashes rather than pupil arcs." />
              <NumberInput label="Circle max RMS" value={edgeCircleFitMaxRms} onChange={setEdgeCircleFitMaxRms} disabled={running} step={0.1}
                hint="Maximum RMS residual (px) of a segment from its fitted circle for the segment to be kept as a pupil-boundary candidate." />
              <NumberInput label="Circle min radius" value={edgeCircleFitMinRadius} onChange={setEdgeCircleFitMinRadius} disabled={running} step={0.5}
                hint="Smallest accepted pupil radius (px) when fitting circles to arc segments." />
              <NumberInput label="Circle max radius" value={edgeCircleFitMaxRadius} onChange={setEdgeCircleFitMaxRadius} disabled={running} step={0.5}
                hint="Largest accepted pupil radius (px) when fitting circles to arc segments." />
              <NumberInput label="Max center dist" value={edgeMaxCenterDist} onChange={setEdgeMaxCenterDist} disabled={running} step={0.05}
                hint="How far a candidate ellipse centre may sit from the ROI centre, as a fraction of the ROI radius. Farther candidates are dropped." />
              <NumberInput label="Support dist (px)" value={edgeSupportDistPx} onChange={setEdgeSupportDistPx} disabled={running} step={0.5}
                hint="Band width (px) around the ellipse contour within which edge pixels count as supporting evidence for that ellipse." />
              <NumberInput label="Support min frac" value={edgeSupportMinFrac} onChange={setEdgeSupportMinFrac} disabled={running} step={0.05}
                hint="Minimum fraction of the ellipse outline that must be backed by edge pixels for the ellipse to be accepted." />
              <NumberInput label="Heatmap prior wt" value={edgeHeatmapPriorWeight} onChange={setEdgeHeatmapPriorWeight} disabled={running} step={0.05}
                hint="Weight of the penalty for candidates far from the HeatmapNet centre when scoring which ellipse wins." />
            </div>
          )}
        </div>
      </div>

      {/* Detector preview — floodfill stages for a single frame, collapsible */}
      <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-5 space-y-4">
        <button
          onClick={() => setPreviewOpen((v) => !v)}
          className="w-full flex items-center justify-between text-xs text-zinc-500 uppercase
                     tracking-wider hover:text-zinc-300 transition-colors cursor-pointer"
        >
          <span className="flex items-center gap-2"><Eye className="w-3.5 h-3.5" /> Detector preview</span>
          <ChevronDown className={`w-4 h-4 transition-transform ${previewOpen ? "rotate-180" : ""}`} />
        </button>

        {previewOpen && (
          <div className="space-y-4">
            {/* Mode toggle */}
            <div className="flex gap-1 bg-zinc-800 p-1 rounded-lg w-fit text-xs">
              {(["frame", "stream"] as const).map((m) => (
                <button
                  key={m}
                  onClick={() => { setPreviewMode(m); if (m === "frame") setStreamPlaying(false); }}
                  className={`px-3 py-1 rounded-md transition-colors cursor-pointer
                    ${previewMode === m ? "bg-indigo-600 text-white" : "text-zinc-400 hover:text-zinc-200"}`}
                >
                  {m === "frame" ? "Single frame (tuning)" : "Live video (all stages)"}
                </button>
              ))}
            </div>

            {previewMode === "frame" ? (
              <div className="space-y-4">
                <p className="text-xs text-zinc-500">
                  Floodfill stages for one eye frame: ROI → detected dark region → fitted ellipse.
                  Tune the parameters above, then re-run Preview.
                </p>

                {/* Frame picker */}
                <div className="flex items-center gap-3">
                  <input
                    type="range"
                    min={0}
                    max={preview ? Math.max(0, preview.total_frames - 1) : 0}
                    value={previewFrame}
                    onChange={(e) => setPreviewFrame(Number(e.target.value))}
                    disabled={!preview || previewLoading}
                    className="flex-1 accent-indigo-500 disabled:opacity-40"
                  />
                  <input
                    type="number"
                    min={0}
                    value={previewFrame}
                    onChange={(e) => setPreviewFrame(Math.max(0, Number(e.target.value)))}
                    className="w-24 bg-zinc-800 text-white text-xs px-2 py-1 rounded border border-zinc-700
                               focus:border-indigo-500 outline-none text-right"
                  />
                  <span className="text-xs text-zinc-500 whitespace-nowrap">
                    {preview ? `/ ${preview.total_frames - 1}` : ""}
                  </span>
                  <button
                    onClick={handlePreview}
                    disabled={previewLoading || !recording.eye_video}
                    className="flex items-center gap-2 px-4 py-1.5 bg-indigo-600 hover:bg-indigo-500
                               disabled:opacity-40 disabled:cursor-not-allowed
                               text-white text-xs font-medium rounded-lg transition-colors cursor-pointer"
                  >
                    {previewLoading ? <RefreshCw className="w-3.5 h-3.5 animate-spin" /> : <Eye className="w-3.5 h-3.5" />}
                    {previewLoading ? "Rendering…" : "Preview"}
                  </button>
                </div>

                {previewError && (
                  <p className="text-xs text-red-400 font-mono break-all">{previewError}</p>
                )}

                {preview ? (
                  <div className="space-y-4">
                    <EyeStagesRow label="Left eye" stages={preview.left} />
                    <EyeStagesRow label="Right eye" stages={preview.right} />
                  </div>
                ) : (
                  !previewError && (
                    <p className="text-xs text-zinc-600">Click Preview to render the current frame.</p>
                  )
                )}
              </div>
            ) : (
              <div className="space-y-4">
                <p className="text-xs text-zinc-500">
                  Runs the full detector on the eye video frame-by-frame (both pipelines) and streams
                  every stage live. Processing paces the playback, so it plays slower than real time.
                </p>

                <div className="flex items-center gap-3">
                  <span className="text-xs text-zinc-400">Start frame</span>
                  <input
                    type="number"
                    min={0}
                    value={streamStart}
                    onChange={(e) => setStreamStart(Math.max(0, Number(e.target.value)))}
                    disabled={streamPlaying}
                    className="w-24 bg-zinc-800 text-white text-xs px-2 py-1 rounded border border-zinc-700
                               focus:border-indigo-500 outline-none text-right disabled:opacity-50"
                  />
                  {streamPlaying ? (
                    <button
                      onClick={handleStreamStop}
                      className="flex items-center gap-2 px-4 py-1.5 bg-zinc-700 hover:bg-zinc-600
                                 text-white text-xs font-medium rounded-lg transition-colors cursor-pointer"
                    >
                      Stop
                    </button>
                  ) : (
                    <button
                      onClick={handleStreamStart}
                      disabled={!recording.eye_video}
                      className="flex items-center gap-2 px-4 py-1.5 bg-indigo-600 hover:bg-indigo-500
                                 disabled:opacity-40 disabled:cursor-not-allowed
                                 text-white text-xs font-medium rounded-lg transition-colors cursor-pointer"
                    >
                      <Play className="w-3.5 h-3.5" /> Start
                    </button>
                  )}
                  <span className="text-xs text-zinc-600">
                    Apply new parameters by pressing Start again.
                  </span>
                </div>

                <div className="bg-black/40 rounded-lg border border-zinc-800 overflow-auto">
                  {streamPlaying ? (
                    <img src={streamUrl} alt="Detector stream" className="w-full block" />
                  ) : (
                    <div className="h-48 flex items-center justify-center text-xs text-zinc-600">
                      Press Start to run the detector live.
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>
        )}
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

function EyeStagesRow({ label, stages }: { label: string; stages: EyeStages }) {
  const found = stages.overlay_png && stages.A !== null;
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium text-zinc-300">{label}</span>
        <span className={`text-[11px] font-mono ${found ? "text-emerald-400" : "text-amber-400"}`}>
          {stages.reason || "—"}
          {found && stages.A !== null && stages.B !== null && (
            <span className="text-zinc-500">
              {"  "}A={stages.A} B={stages.B} ∠{stages.angle}° conf={stages.confidence}
            </span>
          )}
        </span>
      </div>
      <div className="flex gap-3">
        <StageThumb src={stages.roi_png} caption="ROI" />
        <StageArrow />
        <StageThumb src={stages.mask_png} caption="Dark region" />
        <StageArrow />
        <StageThumb src={stages.overlay_png} caption="Fitted ellipse" />
      </div>
    </div>
  );
}

function StageThumb({ src, caption }: { src: string | null; caption: string }) {
  return (
    <div className="flex flex-col items-center gap-1">
      <div className="w-[120px] h-[120px] bg-black/40 rounded-lg border border-zinc-800
                      flex items-center justify-center overflow-hidden">
        {src ? (
          <img src={src} alt={caption} className="max-w-full max-h-full" style={{ imageRendering: "pixelated" }} />
        ) : (
          <span className="text-[10px] text-zinc-600">n/a</span>
        )}
      </div>
      <span className="text-[10px] text-zinc-500">{caption}</span>
    </div>
  );
}

function StageArrow() {
  return <div className="flex items-center text-zinc-600 text-lg pb-5">→</div>;
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center gap-2">
      <span className="text-zinc-500">{label}</span>
      <span className="text-white">{value}</span>
    </div>
  );
}

function NumberInput({
  label, value, onChange, disabled, step, hint,
}: {
  label: string; value: number; onChange: (v: number) => void; disabled: boolean; step?: number; hint?: string;
}) {
  return (
    <div className="group relative flex items-center justify-between">
      <span className={`text-xs text-zinc-400 ${hint ? "cursor-help border-b border-dotted border-zinc-600" : ""}`}>
        {label}
      </span>
      <input
        type="number"
        step={step ?? 1}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        disabled={disabled}
        className="w-20 bg-zinc-800 text-white text-xs px-2 py-1 rounded border border-zinc-700
                   focus:border-indigo-500 outline-none disabled:opacity-50 text-right"
      />
      {hint && (
        <div className="pointer-events-none absolute left-0 bottom-full mb-1 z-30 hidden group-hover:block
                        w-64 bg-zinc-950 border border-zinc-700 rounded-lg px-3 py-2 text-[11px]
                        leading-snug text-zinc-300 shadow-xl">
          {hint}
        </div>
      )}
    </div>
  );
}
