import { useCallback, useEffect, useRef, useState } from "react";
import { Activity, ChevronRight, Pause, Play, RotateCcw } from "lucide-react";
import { api } from "@/lib/api";
import { formatDuration, formatDate } from "@/lib/utils";
import type { RecordingMeta, RecordingEvent, GazePrediction } from "@/types";

const PAPER_W = 794;
const PAPER_H = 1123;
const GAZE_COLOR = "#ef4444";

// ─── Types ────────────────────────────────────────────────────────────────────

interface AoiShape {
  kind: "rect" | "ellipse" | "polygon";
  x: number; y: number; w: number; h: number;
  points?: [number, number][];
}

interface AoiArea {
  id: string; name: string; color: string; visible: boolean;
  shape: AoiShape | null;
}

interface SegmentMeta {
  id: string; label: string; eventPrefix: string | null;
}

// ─── Pure helpers ─────────────────────────────────────────────────────────────

function deriveSegments(events: RecordingEvent[]): SegmentMeta[] {
  const prefixes = [...new Set(
    events.filter(e => e.name.endsWith("_begin")).map(e => e.name.slice(0, -6)),
  )];
  return [
    { id: "general", label: "General", eventPrefix: null },
    ...prefixes.map(p => ({
      id: p,
      label: p.replace(/_/g, " ").replace(/\b\w/g, c => c.toUpperCase()),
      eventPrefix: p,
    })),
  ];
}

// Binary search: first index where preds[i].timestamp_ns >= targetNs
function bsLo(preds: GazePrediction[], targetNs: number): number {
  let lo = 0, hi = preds.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (preds[mid].timestamp_ns < targetNs) lo = mid + 1; else hi = mid;
  }
  return lo;
}

function formatTime(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

function drawBg(
  ctx: CanvasRenderingContext2D,
  img: HTMLImageElement | null,
  areas: AoiArea[],
) {
  ctx.clearRect(0, 0, PAPER_W, PAPER_H);
  if (img) {
    ctx.drawImage(img, 0, 0, PAPER_W, PAPER_H);
  } else {
    ctx.fillStyle = "#e0e0e0";
    ctx.fillRect(0, 0, PAPER_W, PAPER_H);
  }
  for (const area of areas) {
    if (!area.visible || !area.shape) continue;
    const s = area.shape;
    ctx.fillStyle = area.color;
    ctx.strokeStyle = area.color;
    ctx.lineWidth = 2;
    if (s.kind === "rect") {
      ctx.globalAlpha = 0.3;
      ctx.fillRect(s.x * PAPER_W, s.y * PAPER_H, s.w * PAPER_W, s.h * PAPER_H);
      ctx.globalAlpha = 1;
      ctx.strokeRect(s.x * PAPER_W, s.y * PAPER_H, s.w * PAPER_W, s.h * PAPER_H);
    } else if (s.kind === "ellipse") {
      const cx = (s.x + s.w / 2) * PAPER_W;
      const cy = (s.y + s.h / 2) * PAPER_H;
      ctx.beginPath();
      ctx.ellipse(cx, cy, (s.w / 2) * PAPER_W, (s.h / 2) * PAPER_H, 0, 0, Math.PI * 2);
      ctx.globalAlpha = 0.3; ctx.fill();
      ctx.globalAlpha = 1; ctx.stroke();
    } else if (s.kind === "polygon" && s.points) {
      ctx.beginPath();
      s.points.forEach(([px, py], i) =>
        i === 0 ? ctx.moveTo(px * PAPER_W, py * PAPER_H) : ctx.lineTo(px * PAPER_W, py * PAPER_H),
      );
      ctx.closePath();
      ctx.globalAlpha = 0.3; ctx.fill();
      ctx.globalAlpha = 1; ctx.stroke();
    }
  }
}

// ─── Component ────────────────────────────────────────────────────────────────

export function PaperGazePage({ initialRecording }: { initialRecording?: RecordingMeta }) {
  const [recordings, setRecordings] = useState<RecordingMeta[]>([]);
  const [loadingRecs, setLoadingRecs] = useState(true);
  const [recording, setRecording] = useState<RecordingMeta | null>(initialRecording ?? null);
  const [loading, setLoading] = useState(false);

  const [predictions, setPredictions] = useState<GazePrediction[]>([]);
  const [segments, setSegments] = useState<SegmentMeta[]>([]);
  const [activeSegId, setActiveSegId] = useState("general");

  // Playback UI state (drives slider + labels only; actual playback uses refs)
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [playbackSpeed, setPlaybackSpeed] = useState(1);
  const [trailSeconds, setTrailSeconds] = useState(1);

  // Canvas elements
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const bgCanvasRef = useRef<HTMLCanvasElement | null>(null);

  // Stable data refs for RAF (avoid stale closures)
  const predsRef = useRef<GazePrediction[]>([]);         // all predictions sorted by ts
  const filteredRef = useRef<GazePrediction[]>([]);       // on-paper, segment-scoped
  const paperImgRef = useRef<HTMLImageElement | null>(null);
  const lastWarpedRef = useRef<string | null>(null);
  const aoiAreasRef = useRef<AoiArea[]>([]);
  const durationRef = useRef(0);

  // Playback control refs
  const isPlayingRef = useRef(false);
  const currentTimeRef = useRef(0);
  const playbackSpeedRef = useRef(1);
  const trailSecondsRef = useRef(1);
  const rafRef = useRef<number | null>(null);
  const lastTickRef = useRef<number | null>(null);

  // Sync scalar state → refs (for use inside RAF)
  useEffect(() => { isPlayingRef.current = isPlaying; }, [isPlaying]);
  useEffect(() => { playbackSpeedRef.current = playbackSpeed; }, [playbackSpeed]);
  useEffect(() => { trailSecondsRef.current = trailSeconds; }, [trailSeconds]);
  useEffect(() => { durationRef.current = recording?.duration_sec ?? 0; }, [recording]);

  // ─── Data loading ──────────────────────────────────────────────────────────

  useEffect(() => {
    api.get<RecordingMeta[]>("/api/recordings")
      .then(setRecordings)
      .finally(() => setLoadingRecs(false));
  }, []);

  // Rebuild segFilteredRef based on active segment + current predictions
  const rebuildFiltered = useCallback((
    preds: GazePrediction[],
    evts: RecordingEvent[],
    segs: SegmentMeta[],
    segId: string,
    dur: number,
  ) => {
    const onPaper = preds.filter(p => p.paper_x !== null && p.paper_y !== null);
    const seg = segs.find(s => s.id === segId);
    if (!seg?.eventPrefix || !preds.length) { filteredRef.current = onPaper; return; }

    const begin = evts.find(e => e.name === `${seg.eventPrefix}_begin`);
    const end = evts.find(e => e.name === `${seg.eventPrefix}_end`);
    if (!begin) { filteredRef.current = onPaper; return; }

    const t0 = preds[0].timestamp_ns;
    const t1 = preds[preds.length - 1].timestamp_ns;
    const startNs = t0 + (begin.timestamp_s / dur) * (t1 - t0);
    const endNs = end ? t0 + (end.timestamp_s / dur) * (t1 - t0) : t1;
    filteredRef.current = onPaper.filter(p => p.timestamp_ns >= startNs && p.timestamp_ns <= endNs);
  }, []);

  const loadAoiState = useCallback(async (recId: string, segId: string) => {
    try {
      const state = await api.get<{ areas: AoiArea[]; warped_image_b64: string | null }>(
        `/api/recordings/${recId}/aoi/${segId}/state`,
      );
      aoiAreasRef.current = state.areas ?? [];
      const b64 = state.warped_image_b64 ?? null;

      if (b64 && b64 !== lastWarpedRef.current) {
        lastWarpedRef.current = b64;
        const img = new Image();
        img.onload = () => { paperImgRef.current = img; rebuildBgCanvas(); drawFrame(); };
        img.src = `data:image/jpeg;base64,${b64}`;
      } else {
        if (!b64) { lastWarpedRef.current = null; paperImgRef.current = null; }
        rebuildBgCanvas();
        drawFrame();
      }
    } catch {
      aoiAreasRef.current = [];
      lastWarpedRef.current = null;
      paperImgRef.current = null;
      rebuildBgCanvas();
      drawFrame();
    }
  // drawFrame / rebuildBgCanvas are stable (no deps) so safe to omit
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const loadAll = useCallback(async (rec: RecordingMeta) => {
    setLoading(true);
    setIsPlaying(false); isPlayingRef.current = false;
    setCurrentTime(0); currentTimeRef.current = 0;
    lastTickRef.current = null;
    try {
      const [preds, evts] = await Promise.all([
        api.get<GazePrediction[]>(`/api/recordings/${rec.id}/gaze/predictions`)
          .catch(() => [] as GazePrediction[]),
        api.get<RecordingEvent[]>(`/api/recordings/${rec.id}/events`)
          .catch(() => [] as RecordingEvent[]),
      ]);
      predsRef.current = preds;
      setPredictions(preds);

      const segs = deriveSegments(evts);
      try {
        const manifest = await api.get<{ custom_segments: { id: string; label: string }[] }>(
          `/api/recordings/${rec.id}/aoi/segments`,
        );
        const ids = new Set(segs.map(s => s.id));
        for (const cs of manifest.custom_segments) {
          if (!ids.has(cs.id)) segs.push({ id: cs.id, label: cs.label, eventPrefix: null });
        }
      } catch { /* no manifest */ }

      setSegments(segs);
      setActiveSegId(segs[0].id);
      rebuildFiltered(preds, evts, segs, segs[0].id, rec.duration_sec ?? 1);
      await loadAoiState(rec.id, segs[0].id);
    } finally {
      setLoading(false);
    }
  }, [loadAoiState, rebuildFiltered]);

  useEffect(() => {
    if (initialRecording) loadAll(initialRecording);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleSelectRecording = async (rec: RecordingMeta) => {
    setRecording(rec);
    setPredictions([]); predsRef.current = [];
    setSegments([]); filteredRef.current = [];
    aoiAreasRef.current = []; lastWarpedRef.current = null; paperImgRef.current = null;
    await loadAll(rec);
  };

  const handleTabChange = async (segId: string, evts: RecordingEvent[], segs: SegmentMeta[]) => {
    setActiveSegId(segId);
    rebuildFiltered(predsRef.current, evts, segs, segId, recording?.duration_sec ?? 1);
    if (recording) await loadAoiState(recording.id, segId);
  };

  // ─── Canvas drawing ────────────────────────────────────────────────────────

  // Rebuild the offscreen background (paper + AoI areas) into bgCanvasRef
  function rebuildBgCanvas() {
    if (!bgCanvasRef.current) {
      bgCanvasRef.current = document.createElement("canvas");
      bgCanvasRef.current.width = PAPER_W;
      bgCanvasRef.current.height = PAPER_H;
    }
    const ctx = bgCanvasRef.current.getContext("2d");
    if (ctx) drawBg(ctx, paperImgRef.current, aoiAreasRef.current);
  }

  // Draw one frame at the given time (or currentTimeRef if omitted)
  const drawFrame = useCallback((atTime?: number) => {
    const canvas = canvasRef.current;
    const bgCanvas = bgCanvasRef.current;
    if (!canvas || !bgCanvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    ctx.drawImage(bgCanvas, 0, 0);

    const filtered = filteredRef.current;
    const preds = predsRef.current;
    if (!filtered.length || !preds.length) return;

    const t = atTime ?? currentTimeRef.current;
    const dur = durationRef.current;
    if (!dur) return;

    const t0 = preds[0].timestamp_ns;
    const t1 = preds[preds.length - 1].timestamp_ns;
    const targetNs = t0 + (t / dur) * (t1 - t0);
    const trailDurNs = Math.max(1, (trailSecondsRef.current / dur) * (t1 - t0));
    const startNs = targetNs - trailDurNs;

    const lo = bsLo(filtered, startNs);
    const hi = bsLo(filtered, targetNs + 1); // +1 to include exact match
    if (lo >= hi) return;

    ctx.fillStyle = GAZE_COLOR;
    for (let i = lo; i < hi; i++) {
      const p = filtered[i];
      if (p.paper_x === null || p.paper_y === null) continue;
      const age = (targetNs - p.timestamp_ns) / trailDurNs; // 0=newest, 1=oldest
      ctx.globalAlpha = Math.max(0.04, 1 - age * 0.88);
      const r = Math.max(1.5, 7 * (1 - age * 0.65));
      ctx.beginPath();
      ctx.arc(p.paper_x * PAPER_W, p.paper_y * PAPER_H, r, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  }, []);

  // ─── RAF playback loop ─────────────────────────────────────────────────────

  useEffect(() => {
    if (!isPlaying) {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
      lastTickRef.current = null;
      return;
    }

    const tick = (now: number) => {
      if (!isPlayingRef.current) return;
      if (lastTickRef.current !== null) {
        const delta = (now - lastTickRef.current) / 1000 * playbackSpeedRef.current;
        const dur = durationRef.current;
        currentTimeRef.current = Math.min(currentTimeRef.current + delta, dur);
        setCurrentTime(currentTimeRef.current);
        if (currentTimeRef.current >= dur) {
          setIsPlaying(false);
          isPlayingRef.current = false;
          drawFrame(currentTimeRef.current);
          return;
        }
      }
      lastTickRef.current = now;
      drawFrame(currentTimeRef.current);
      rafRef.current = requestAnimationFrame(tick);
    };

    rafRef.current = requestAnimationFrame(tick);
    return () => { if (rafRef.current) cancelAnimationFrame(rafRef.current); };
  }, [isPlaying, drawFrame]);

  // ─── Playback controls ─────────────────────────────────────────────────────

  const handleSeek = (t: number) => {
    currentTimeRef.current = t;
    lastTickRef.current = null; // prevent time jump on next RAF tick
    setCurrentTime(t);
    if (!isPlayingRef.current) drawFrame(t);
  };

  const handleTogglePlay = () => {
    if (currentTimeRef.current >= (recording?.duration_sec ?? 0) - 0.01) {
      currentTimeRef.current = 0;
      setCurrentTime(0);
    }
    setIsPlaying(v => !v);
  };

  const handleReset = () => {
    setIsPlaying(false);
    currentTimeRef.current = 0;
    setCurrentTime(0);
    lastTickRef.current = null;
    setTimeout(() => drawFrame(0), 0); // after isPlaying→false RAF cleanup
  };

  const setTrail = (s: number) => {
    trailSecondsRef.current = s;
    setTrailSeconds(s);
    if (!isPlayingRef.current) drawFrame();
  };

  const setSpeed = (s: number) => {
    playbackSpeedRef.current = s;
    setPlaybackSpeed(s);
  };

  const duration = recording?.duration_sec ?? 0;
  const hasGaze = predictions.length > 0;

  // ─── Recording list panel ──────────────────────────────────────────────────

  const recListPanel = (
    <div className="w-64 border-r border-zinc-800 flex flex-col shrink-0">
      <div className="px-4 py-3 border-b border-zinc-800">
        <span className="text-sm font-medium text-white">Recordings</span>
      </div>
      <div className="flex-1 overflow-auto">
        {loadingRecs ? (
          <p className="text-zinc-500 text-xs p-4">Loading…</p>
        ) : recordings.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-12 text-zinc-600">
            <Activity className="w-8 h-8 mb-2 opacity-30" />
            <p className="text-xs">No recordings</p>
          </div>
        ) : (
          recordings.map(rec => (
            <button
              key={rec.id}
              onClick={() => handleSelectRecording(rec)}
              className={`w-full flex items-center gap-3 px-4 py-3 text-left border-b border-zinc-800/50
                transition-colors cursor-pointer
                ${recording?.id === rec.id ? "bg-zinc-800" : "hover:bg-zinc-900"}`}
            >
              <Activity className={`w-4 h-4 shrink-0 ${rec.has_gaze_result ? "text-indigo-400" : "text-zinc-600"}`} />
              <div className="flex-1 min-w-0">
                <p className="text-sm text-white truncate">{rec.name}</p>
                <p className="text-xs text-zinc-500">
                  {rec.wearer_name} · {formatDuration(rec.duration_sec)} · {formatDate(rec.start_time)}
                </p>
                {!rec.has_gaze_result && (
                  <p className="text-[10px] text-amber-600/80 mt-0.5">No gaze data</p>
                )}
              </div>
              <ChevronRight className="w-3.5 h-3.5 text-zinc-600 shrink-0" />
            </button>
          ))
        )}
      </div>
    </div>
  );

  if (!recording) {
    return (
      <div className="flex h-full">
        {recListPanel}
        <div className="flex-1 flex items-center justify-center text-zinc-600">
          <div className="text-center">
            <Activity className="w-10 h-10 mb-3 mx-auto opacity-20" />
            <p className="text-sm">Select a recording to visualize gaze on paper</p>
          </div>
        </div>
      </div>
    );
  }

  // ─── Full layout with player ───────────────────────────────────────────────

  return (
    <div className="flex h-full">
      {recListPanel}

      <div className="flex flex-col flex-1 min-w-0 overflow-hidden">
        {/* Segment tabs */}
        {segments.length > 0 && (
          <div className="flex items-center border-b border-zinc-800 px-2 shrink-0 bg-zinc-950">
            {segments.map(seg => (
              <button
                key={seg.id}
                onClick={() => handleTabChange(seg.id, [], segments)}
                className={`px-4 py-2 text-xs font-medium border-b-2 transition-colors cursor-pointer
                  ${activeSegId === seg.id
                    ? "border-indigo-500 text-white"
                    : "border-transparent text-zinc-500 hover:text-zinc-300"}`}
              >
                {seg.label}
              </button>
            ))}
          </div>
        )}

        {/* Paper canvas area */}
        <div className="flex-1 overflow-hidden flex items-center justify-center p-4 bg-zinc-950 min-h-0">
          {loading ? (
            <div className="flex items-center gap-2 text-zinc-500 text-sm">
              <div className="w-4 h-4 border-2 border-zinc-600 border-t-indigo-400 rounded-full animate-spin" />
              Loading gaze data…
            </div>
          ) : (
            <div
              className="relative border border-zinc-700 rounded shadow-2xl"
              style={{
                aspectRatio: `${PAPER_W}/${PAPER_H}`,
                maxHeight: "100%",
                maxWidth: "100%",
                height: "100%",
              }}
            >
              <canvas ref={canvasRef} width={PAPER_W} height={PAPER_H} className="w-full h-full rounded" />
              {!hasGaze && (
                <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
                  <div className="bg-zinc-900/90 rounded-lg px-5 py-4 text-center border border-zinc-700">
                    <Activity className="w-6 h-6 mx-auto mb-2 text-zinc-500" />
                    <p className="text-sm text-zinc-300">No gaze data</p>
                    <p className="text-xs text-zinc-500 mt-1">Run gaze mapping first</p>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>

        {/* Timeline + controls */}
        <div className="shrink-0 border-t border-zinc-800 bg-zinc-900 px-4 pt-3 pb-3 space-y-2">
          {/* Scrubber */}
          <input
            type="range" min={0} max={duration || 1} step={0.033} value={currentTime}
            onChange={e => handleSeek(+e.target.value)}
            disabled={loading || !hasGaze}
            className="w-full accent-indigo-500 cursor-pointer disabled:opacity-30"
            style={{ height: "4px" }}
          />

          {/* Controls row */}
          <div className="flex items-center gap-3">
            {/* Reset */}
            <button
              onClick={handleReset}
              disabled={loading || !hasGaze}
              title="Reset"
              className="p-1 text-zinc-400 hover:text-white disabled:opacity-30 disabled:cursor-not-allowed cursor-pointer transition-colors"
            >
              <RotateCcw className="w-3.5 h-3.5" />
            </button>

            {/* Play/Pause */}
            <button
              onClick={handleTogglePlay}
              disabled={loading || !hasGaze}
              className="flex items-center justify-center w-7 h-7 rounded-full bg-indigo-600 hover:bg-indigo-500
                disabled:opacity-30 disabled:cursor-not-allowed cursor-pointer transition-colors"
            >
              {isPlaying
                ? <Pause className="w-3.5 h-3.5 text-white" style={{ fill: "white" }} />
                : <Play className="w-3.5 h-3.5 text-white ml-px" style={{ fill: "white" }} />}
            </button>

            {/* Time display */}
            <span className="text-xs text-zinc-400 font-mono tabular-nums">
              {formatTime(currentTime)} / {formatTime(duration)}
            </span>

            {/* Trail */}
            <div className="flex items-center gap-1 ml-auto">
              <span className="text-[10px] text-zinc-500 mr-1">Trail</span>
              {[0.5, 1, 2, 5].map(s => (
                <button
                  key={s}
                  onClick={() => setTrail(s)}
                  className={`px-1.5 py-0.5 text-[10px] rounded cursor-pointer transition-colors
                    ${trailSeconds === s ? "bg-indigo-600 text-white" : "text-zinc-500 hover:text-zinc-200"}`}
                >
                  {s}s
                </button>
              ))}
            </div>

            {/* Speed */}
            <div className="flex items-center gap-1 ml-3">
              <span className="text-[10px] text-zinc-500 mr-1">Speed</span>
              {[0.25, 0.5, 1, 2].map(s => (
                <button
                  key={s}
                  onClick={() => setSpeed(s)}
                  className={`px-1.5 py-0.5 text-[10px] rounded cursor-pointer transition-colors
                    ${playbackSpeed === s ? "bg-indigo-600 text-white" : "text-zinc-500 hover:text-zinc-200"}`}
                >
                  {s}×
                </button>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
