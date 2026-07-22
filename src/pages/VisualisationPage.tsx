import { useEffect, useMemo, useState } from "react";
import { ChartScatter, ChevronRight, Download, Flame, Grid3x3, Loader2, Route } from "lucide-react";
import { save } from "@tauri-apps/plugin-dialog";
import { api } from "@/lib/api";
import { formatDuration, formatDate } from "@/lib/utils";
import { RecordingThumbnail } from "@/components/player/RecordingThumbnail";
import type { RecordingMeta, RecordingEvent, GazePrediction, Fixation } from "@/types";

// Surface (warped paper) canvas resolution — shared with AoI / Surface Map so
// normalized surface coords (0..1) map the same way everywhere.
const PAPER_W = 794;
const PAPER_H = 1123;

type Mode = "heatmap" | "aoi" | "scanpath";
type AoiMetric = "dwell" | "count";

// ─── Local types (mirror the AoI editor's persisted shapes) ────────────────────

interface AoiShape {
  kind: "rect" | "ellipse" | "polygon";
  x: number; y: number; w: number; h: number;
  points?: [number, number][];
}
interface AoiArea {
  id: string; name: string; color: string; visible: boolean;
  shape: AoiShape | null;
}
interface SegmentMeta { id: string; label: string; eventPrefix: string | null; }

// ─── Palette (blue→cyan→green→yellow→red), shared by canvas + colorbar ──────────

const PALETTE_CSS =
  "linear-gradient(to top, #0000ff 0%, #00ffff 25%, #00ff00 50%, #ffff00 75%, #ff0000 100%)";

let _palette: Uint8ClampedArray | null = null;
function getPalette(): Uint8ClampedArray {
  if (_palette) return _palette;
  const c = document.createElement("canvas");
  c.width = 256; c.height = 1;
  const ctx = c.getContext("2d")!;
  const g = ctx.createLinearGradient(0, 0, 256, 0);
  g.addColorStop(0.0, "#0000ff");
  g.addColorStop(0.25, "#00ffff");
  g.addColorStop(0.5, "#00ff00");
  g.addColorStop(0.75, "#ffff00");
  g.addColorStop(1.0, "#ff0000");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 256, 1);
  _palette = ctx.getImageData(0, 0, 256, 1).data;
  return _palette;
}

// ─── Pure helpers ──────────────────────────────────────────────────────────────

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

// [startNs, endNs] device-timestamp window for a segment. General (no prefix)
// spans the whole recording. Uses the same proportional map as Surface Map.
function segWindowNs(
  preds: GazePrediction[], events: RecordingEvent[], seg: SegmentMeta | undefined, dur: number,
): [number, number] | null {
  if (!preds.length) return null;
  const t0 = preds[0].timestamp_ns;
  const t1 = preds[preds.length - 1].timestamp_ns;
  if (!seg?.eventPrefix || !dur) return [t0, t1];
  const begin = events.find(e => e.name === `${seg.eventPrefix}_begin`);
  const end = events.find(e => e.name === `${seg.eventPrefix}_end`);
  if (!begin) return [t0, t1];
  const startNs = t0 + (begin.timestamp_s / dur) * (t1 - t0);
  const endNs = end ? t0 + (end.timestamp_s / dur) * (t1 - t0) : t1;
  return [startNs, endNs];
}

function pointInShape(px: number, py: number, s: AoiShape): boolean {
  if (s.kind === "rect") {
    return px >= s.x && px <= s.x + s.w && py >= s.y && py <= s.y + s.h;
  }
  if (s.kind === "ellipse") {
    const rx = s.w / 2, ry = s.h / 2;
    if (rx <= 0 || ry <= 0) return false;
    const dx = (px - (s.x + rx)) / rx, dy = (py - (s.y + ry)) / ry;
    return dx * dx + dy * dy <= 1;
  }
  if (s.kind === "polygon" && s.points && s.points.length >= 3) {
    let inside = false;
    const pts = s.points;
    for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
      const [xi, yi] = pts[i], [xj, yj] = pts[j];
      const hit = (yi > py) !== (yj > py) &&
        px < ((xj - xi) * (py - yi)) / (yj - yi) + xi;
      if (hit) inside = !inside;
    }
    return inside;
  }
  return false;
}

function shapeCentroid(s: AoiShape): [number, number] {
  if (s.kind === "polygon" && s.points && s.points.length) {
    const n = s.points.length;
    const sx = s.points.reduce((a, [x]) => a + x, 0) / n;
    const sy = s.points.reduce((a, [, y]) => a + y, 0) / n;
    return [sx, sy];
  }
  return [s.x + s.w / 2, s.y + s.h / 2];
}

function shapePath(ctx: CanvasRenderingContext2D, s: AoiShape) {
  ctx.beginPath();
  if (s.kind === "rect") {
    ctx.rect(s.x * PAPER_W, s.y * PAPER_H, s.w * PAPER_W, s.h * PAPER_H);
  } else if (s.kind === "ellipse") {
    ctx.ellipse(
      (s.x + s.w / 2) * PAPER_W, (s.y + s.h / 2) * PAPER_H,
      (s.w / 2) * PAPER_W, (s.h / 2) * PAPER_H, 0, 0, Math.PI * 2,
    );
  } else if (s.kind === "polygon" && s.points) {
    s.points.forEach(([x, y], i) =>
      i === 0 ? ctx.moveTo(x * PAPER_W, y * PAPER_H) : ctx.lineTo(x * PAPER_W, y * PAPER_H));
    ctx.closePath();
  }
}

// ─── Canvas renderers ──────────────────────────────────────────────────────────

// heatmap.js-style density: accumulate soft radial blobs into a shadow buffer,
// then colorize by intensity relative to the busiest pixel (→ 0..100% colorbar).
function drawHeatmap(ctx: CanvasRenderingContext2D, pts: GazePrediction[], radius: number) {
  if (!pts.length) return;
  const shadow = document.createElement("canvas");
  shadow.width = PAPER_W; shadow.height = PAPER_H;
  const sctx = shadow.getContext("2d");
  if (!sctx) return;

  sctx.globalAlpha = 0.2;
  for (const p of pts) {
    if (p.paper_x === null || p.paper_y === null) continue;
    const x = p.paper_x * PAPER_W, y = p.paper_y * PAPER_H;
    const g = sctx.createRadialGradient(x, y, 0, x, y, radius);
    g.addColorStop(0, "rgba(0,0,0,1)");
    g.addColorStop(1, "rgba(0,0,0,0)");
    sctx.fillStyle = g;
    sctx.beginPath();
    sctx.arc(x, y, radius, 0, Math.PI * 2);
    sctx.fill();
  }

  const img = sctx.getImageData(0, 0, PAPER_W, PAPER_H);
  const d = img.data;
  let maxA = 1;
  for (let i = 3; i < d.length; i += 4) if (d[i] > maxA) maxA = d[i];
  const lut = getPalette();
  for (let i = 0; i < d.length; i += 4) {
    const a = d[i + 3];
    if (a === 0) continue;
    const t = Math.min(255, Math.round((a / maxA) * 255));
    d[i] = lut[t * 4];
    d[i + 1] = lut[t * 4 + 1];
    d[i + 2] = lut[t * 4 + 2];
    d[i + 3] = Math.round(Math.min(1, a / maxA) * 255 * 0.82);
  }
  sctx.putImageData(img, 0, 0);
  ctx.drawImage(shadow, 0, 0);
}

interface AoiValue { area: AoiArea; dwell: number; count: number; }

function drawAoi(ctx: CanvasRenderingContext2D, values: AoiValue[], metric: AoiMetric, max: number) {
  const lut = getPalette();
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  for (const { area, dwell, count } of values) {
    if (!area.shape) continue;
    const v = metric === "dwell" ? dwell : count;
    const t = Math.max(0, Math.min(255, Math.round((v / max) * 255)));
    const r = lut[t * 4], g = lut[t * 4 + 1], b = lut[t * 4 + 2];

    shapePath(ctx, area.shape);
    ctx.fillStyle = `rgba(${r},${g},${b},0.6)`;
    ctx.fill();
    ctx.lineWidth = 2;
    ctx.strokeStyle = `rgba(${r},${g},${b},0.95)`;
    ctx.stroke();

    // Value label at the centroid.
    const [cx, cy] = shapeCentroid(area.shape);
    const label = metric === "dwell" ? `${Math.round(dwell)} ms` : `${count}`;
    ctx.font = "600 15px system-ui, sans-serif";
    ctx.lineWidth = 3;
    ctx.strokeStyle = "rgba(0,0,0,0.65)";
    ctx.strokeText(label, cx * PAPER_W, cy * PAPER_H);
    ctx.fillStyle = "#fff";
    ctx.fillText(label, cx * PAPER_W, cy * PAPER_H);
  }
}

function drawScanpath(ctx: CanvasRenderingContext2D, fixs: Fixation[]) {
  if (!fixs.length) return;
  const pt = (f: Fixation): [number, number] => [f.norm_x! * PAPER_W, f.norm_y! * PAPER_H];

  // Saccade lines under the circles.
  ctx.lineWidth = 2;
  ctx.strokeStyle = "rgba(99,102,241,0.55)";
  ctx.beginPath();
  fixs.forEach((f, i) => {
    const [x, y] = pt(f);
    i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
  });
  ctx.stroke();

  // Fixation circles (radius ∝ √duration) + order number.
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  fixs.forEach((f, i) => {
    const [x, y] = pt(f);
    const r = 9 + Math.sqrt(f.duration_ms) * 0.55;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fillStyle = "rgba(99,102,241,0.32)";
    ctx.fill();
    ctx.lineWidth = 2;
    ctx.strokeStyle = "rgba(129,140,248,0.95)";
    ctx.stroke();
    ctx.font = "600 12px system-ui, sans-serif";
    ctx.fillStyle = "#fff";
    ctx.fillText(String(i + 1), x, y);
  });
}

// Compose the downloadable bitmap: the surface canvas plus, for heatmap / AoI, a
// labelled colorbar on a white margin, so the PNG is a self-contained figure.
function buildExportCanvas(
  source: HTMLCanvasElement, mode: Mode, metric: AoiMetric, max: number,
): HTMLCanvasElement {
  const hasBar = mode !== "scanpath";
  const margin = hasBar ? 150 : 0;
  const out = document.createElement("canvas");
  out.width = PAPER_W + margin;
  out.height = PAPER_H;
  const ctx = out.getContext("2d")!;
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, out.width, out.height);
  ctx.drawImage(source, 0, 0);
  if (!hasBar) return out;

  const bw = 34;
  const bx = PAPER_W + 34;
  const by = Math.round(PAPER_H * 0.15);
  const bh = Math.round(PAPER_H * 0.7);
  const g = ctx.createLinearGradient(0, by + bh, 0, by);
  g.addColorStop(0.0, "#0000ff");
  g.addColorStop(0.25, "#00ffff");
  g.addColorStop(0.5, "#00ff00");
  g.addColorStop(0.75, "#ffff00");
  g.addColorStop(1.0, "#ff0000");
  ctx.fillStyle = g;
  ctx.fillRect(bx, by, bw, bh);
  ctx.strokeStyle = "#333";
  ctx.lineWidth = 1;
  ctx.strokeRect(bx, by, bw, bh);

  const unit = mode === "heatmap" ? "%" : metric === "dwell" ? " ms" : "";
  const ticks: [number, string][] = [
    [by, mode === "heatmap" ? "100" : String(Math.round(max))],
    [by + bh / 2, mode === "heatmap" ? "50" : String(Math.round(max / 2))],
    [by + bh, "0"],
  ];
  ctx.fillStyle = "#111";
  ctx.font = "20px system-ui, sans-serif";
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  for (const [y, label] of ticks) ctx.fillText(label + unit, bx + bw + 10, y);
  return out;
}

// ─── Colorbar ──────────────────────────────────────────────────────────────────

function Colorbar({ mode, metric, max }: { mode: Mode; metric: AoiMetric; max: number }) {
  if (mode === "scanpath") return null;
  const unit = mode === "heatmap" ? "%" : metric === "dwell" ? " ms" : "";
  const top = mode === "heatmap" ? "100" : String(Math.round(max));
  const mid = mode === "heatmap" ? "50" : String(Math.round(max / 2));
  return (
    <div className="flex flex-col items-center gap-2 shrink-0 pl-1">
      <span className="text-[10px] text-zinc-400 tabular-nums">{top}{unit}</span>
      <div className="relative flex-1 w-3 rounded" style={{ background: PALETTE_CSS, minHeight: 120 }}>
        <span className="absolute left-4 top-1/2 -translate-y-1/2 text-[10px] text-zinc-500 tabular-nums whitespace-nowrap">
          {mid}{unit}
        </span>
      </div>
      <span className="text-[10px] text-zinc-400 tabular-nums">0{unit}</span>
    </div>
  );
}

// ─── Component ───────────────────────────────────────────────────────────────────

export function VisualisationPage({ initialRecording }: { initialRecording?: RecordingMeta }) {
  const [recordings, setRecordings] = useState<RecordingMeta[]>([]);
  const [loadingRecs, setLoadingRecs] = useState(true);
  const [recording, setRecording] = useState<RecordingMeta | null>(initialRecording ?? null);
  const [loading, setLoading] = useState(false);

  const [predictions, setPredictions] = useState<GazePrediction[]>([]);
  const [fixations, setFixations] = useState<Fixation[]>([]);
  const [events, setEvents] = useState<RecordingEvent[]>([]);
  const [segments, setSegments] = useState<SegmentMeta[]>([]);
  const [activeSegId, setActiveSegId] = useState("general");
  const [areas, setAreas] = useState<AoiArea[]>([]);
  const [paperImg, setPaperImg] = useState<HTMLImageElement | null>(null);

  const [mode, setMode] = useState<Mode>("heatmap");
  const [aoiMetric, setAoiMetric] = useState<AoiMetric>("dwell");
  const [radius, setRadius] = useState(40);
  const [saving, setSaving] = useState(false);

  // Canvas kept in state (not a ref) so the render effect re-runs once it mounts.
  const [canvas, setCanvas] = useState<HTMLCanvasElement | null>(null);

  const duration = recording?.duration_sec ?? 0;

  // ─── Data loading ──────────────────────────────────────────────────────────

  useEffect(() => {
    api.get<RecordingMeta[]>("/api/recordings")
      .then(setRecordings)
      .finally(() => setLoadingRecs(false));
  }, []);

  const loadAoiState = async (recId: string, segId: string) => {
    try {
      const state = await api.get<{ areas: AoiArea[]; warped_image_b64: string | null }>(
        `/api/recordings/${recId}/aoi/${segId}/state`,
      );
      setAreas(state.areas ?? []);
      const b64 = state.warped_image_b64 ?? null;
      if (b64) {
        const img = new Image();
        img.onload = () => setPaperImg(img);
        img.src = `data:image/jpeg;base64,${b64}`;
      } else {
        setPaperImg(null);
      }
    } catch {
      setAreas([]);
      setPaperImg(null);
    }
  };

  const loadAll = async (rec: RecordingMeta) => {
    setLoading(true);
    try {
      const [preds, fixs, evts] = await Promise.all([
        api.get<GazePrediction[]>(`/api/recordings/${rec.id}/gaze/predictions`).catch(() => [] as GazePrediction[]),
        api.get<Fixation[]>(`/api/recordings/${rec.id}/gaze/fixations`).catch(() => [] as Fixation[]),
        api.get<RecordingEvent[]>(`/api/recordings/${rec.id}/events`).catch(() => [] as RecordingEvent[]),
      ]);
      setPredictions(preds);
      setFixations(fixs);
      setEvents(evts);

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
      await loadAoiState(rec.id, segs[0].id);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (initialRecording) loadAll(initialRecording);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleSelectRecording = async (rec: RecordingMeta) => {
    setRecording(rec);
    setPredictions([]); setFixations([]); setEvents([]); setSegments([]);
    setAreas([]); setPaperImg(null);
    await loadAll(rec);
  };

  const handleBack = () => {
    setRecording(null);
    setPredictions([]); setFixations([]); setEvents([]); setSegments([]);
    setAreas([]); setPaperImg(null);
  };

  const handleSegment = async (segId: string) => {
    setActiveSegId(segId);
    if (recording) await loadAoiState(recording.id, segId);
  };

  // ─── Derived data (segment-windowed) ─────────────────────────────────────────

  const activeSeg = useMemo(() => segments.find(s => s.id === activeSegId), [segments, activeSegId]);
  const windowNs = useMemo(
    () => segWindowNs(predictions, events, activeSeg, duration),
    [predictions, events, activeSeg, duration],
  );

  const gazePts = useMemo(() => {
    if (!windowNs) return [];
    const [lo, hi] = windowNs;
    return predictions.filter(p =>
      p.paper_x !== null && p.paper_y !== null && p.timestamp_ns >= lo && p.timestamp_ns <= hi);
  }, [predictions, windowNs]);

  const segFix = useMemo(() => {
    const lo = windowNs?.[0] ?? -Infinity;
    const hi = windowNs?.[1] ?? Infinity;
    return fixations
      .filter(f => f.on_surface && f.norm_x !== null && f.norm_y !== null
        && f.start_ts_ns >= lo && f.start_ts_ns <= hi)
      .sort((a, b) => a.start_ts_ns - b.start_ts_ns);
  }, [fixations, windowNs]);

  const aoiValues = useMemo<AoiValue[]>(() => {
    return areas.filter(a => a.shape).map(area => {
      let dwell = 0, count = 0;
      for (const f of segFix) {
        if (f.norm_x === null || f.norm_y === null) continue;
        if (pointInShape(f.norm_x, f.norm_y, area.shape!)) { dwell += f.duration_ms; count++; }
      }
      return { area, dwell, count };
    });
  }, [areas, segFix]);

  const aoiMax = useMemo(
    () => Math.max(1, ...aoiValues.map(v => (aoiMetric === "dwell" ? v.dwell : v.count))),
    [aoiValues, aoiMetric],
  );

  // ─── Render ──────────────────────────────────────────────────────────────────

  useEffect(() => {
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, PAPER_W, PAPER_H);
    if (paperImg) ctx.drawImage(paperImg, 0, 0, PAPER_W, PAPER_H);
    else { ctx.fillStyle = "#e5e5e5"; ctx.fillRect(0, 0, PAPER_W, PAPER_H); }

    if (mode === "heatmap") drawHeatmap(ctx, gazePts, radius);
    else if (mode === "aoi") drawAoi(ctx, aoiValues, aoiMetric, aoiMax);
    else if (mode === "scanpath") drawScanpath(ctx, segFix);
  }, [canvas, mode, paperImg, gazePts, segFix, aoiValues, aoiMetric, aoiMax, radius]);

  // Save the composited figure (surface + overlay + colorbar) as a PNG. Like the
  // CSV export, the Tauri webview can't download directly, so a native save
  // dialog picks the path and the backend writes the decoded bytes.
  const downloadPng = async () => {
    if (!canvas || !recording) return;
    setSaving(true);
    try {
      const out = buildExportCanvas(canvas, mode, aoiMetric, aoiMax);
      const b64 = out.toDataURL("image/png").split(",")[1];
      const safe = `${recording.name}_${mode}_${activeSegId}`.replace(/[^a-zA-Z0-9_-]+/g, "_");
      const dest = await save({
        defaultPath: `${safe}.png`,
        filters: [{ name: "PNG image", extensions: ["png"] }],
      });
      if (!dest) return; // cancelled
      await api.post("/api/export/save-image", { dest, image_b64: b64 });
    } catch (e) {
      console.error("PNG export failed", e);
    } finally {
      setSaving(false);
    }
  };

  // ─── Recording selector ──────────────────────────────────────────────────────

  if (!recording) {
    return (
      <div className="flex h-full">
        <div className="w-80 border-r border-zinc-800 flex flex-col">
          <div className="flex-1 overflow-auto">
            {loadingRecs ? (
              <p className="text-zinc-500 text-xs p-4">Loading…</p>
            ) : recordings.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-12 text-zinc-600">
                <ChartScatter className="w-8 h-8 mb-2 opacity-30" />
                <p className="text-xs">No recordings yet</p>
              </div>
            ) : (
              recordings.map(rec => (
                <button
                  key={rec.id}
                  onClick={() => handleSelectRecording(rec)}
                  className="w-full flex items-center gap-3 px-4 py-3 text-left
                             border-b border-zinc-800/50 hover:bg-zinc-900 transition-colors cursor-pointer"
                >
                  <RecordingThumbnail recordingId={rec.id} />
                  <div className="flex-1 min-w-0">
                    <p className="text-sm text-white truncate">{rec.name}</p>
                    <p className="text-xs text-zinc-500">
                      {rec.wearer_name} · {formatDuration(rec.duration_sec)} · {formatDate(rec.start_time)}
                    </p>
                  </div>
                  <ChevronRight className="w-3.5 h-3.5 text-zinc-600 shrink-0" />
                </button>
              ))
            )}
          </div>
        </div>
        <div className="flex-1 flex items-center justify-center text-zinc-600">
          <div className="text-center">
            <ChartScatter className="w-10 h-10 mb-3 mx-auto opacity-20" />
            <p className="text-sm">Select a recording to visualize gaze</p>
          </div>
        </div>
      </div>
    );
  }

  const MODES: { id: Mode; label: string; Icon: React.ElementType }[] = [
    { id: "heatmap", label: "Heatmap", Icon: Flame },
    { id: "aoi", label: "AoI Heatmap", Icon: Grid3x3 },
    { id: "scanpath", label: "Scanpath", Icon: Route },
  ];

  const emptyMsg =
    mode === "heatmap" && gazePts.length === 0 ? "No gaze mapped onto the surface for this segment. Define the paper surface in the AoI page and run gaze mapping."
    : mode === "scanpath" && segFix.length === 0 ? "No on-surface fixations for this segment. Needs fixation detection (Gaze page) and a mapped surface."
    : mode === "aoi" && areas.length === 0 ? "No Areas of Interest defined — draw them in the AoI page first."
    : mode === "aoi" && segFix.length === 0 ? "No on-surface fixations for this segment. Run fixation detection in the Gaze page."
    : null;

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Header */}
      <div className="flex items-center gap-3 px-4 h-11 border-b border-zinc-800 shrink-0">
        <button onClick={handleBack} className="text-xs text-zinc-400 hover:text-white transition-colors cursor-pointer">
          ← All Recordings
        </button>
        <span className="text-zinc-700">|</span>
        <span className="text-sm font-medium text-white">{recording.name}</span>
        {recording.wearer_name && <span className="text-xs text-zinc-500">{recording.wearer_name}</span>}
      </div>

      {/* Mode switch + mode controls */}
      <div className="flex items-center gap-2 px-4 py-2 border-b border-zinc-800 shrink-0 bg-zinc-950">
        <div className="flex items-center gap-1 bg-zinc-900 rounded-lg p-0.5">
          {MODES.map(({ id, label, Icon }) => (
            <button
              key={id}
              onClick={() => setMode(id)}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium transition-colors cursor-pointer
                ${mode === id ? "bg-indigo-600 text-white" : "text-zinc-400 hover:text-white"}`}
            >
              <Icon className="w-3.5 h-3.5" />
              {label}
            </button>
          ))}
        </div>

        <div className="ml-auto flex items-center gap-3">
          {mode === "heatmap" && (
            <label className="flex items-center gap-2 text-[11px] text-zinc-400">
              Radius
              <input
                type="range" min={15} max={80} value={radius}
                onChange={e => setRadius(Number(e.target.value))}
                className="w-28 cursor-pointer"
              />
              <span className="tabular-nums w-6 text-zinc-300">{radius}</span>
            </label>
          )}
          {mode === "aoi" && (
            <div className="flex items-center gap-1 bg-zinc-900 rounded-lg p-0.5">
              {(["dwell", "count"] as AoiMetric[]).map(m => (
                <button
                  key={m}
                  onClick={() => setAoiMetric(m)}
                  className={`px-2.5 py-1 rounded-md text-[11px] font-medium transition-colors cursor-pointer
                    ${aoiMetric === m ? "bg-indigo-600 text-white" : "text-zinc-400 hover:text-white"}`}
                >
                  {m === "dwell" ? "Dwell time" : "Fixation count"}
                </button>
              ))}
            </div>
          )}

          <button
            onClick={downloadPng}
            disabled={saving || loading || !!emptyMsg}
            title="Download as PNG"
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium
              bg-zinc-800 text-zinc-200 hover:bg-zinc-700 transition-colors cursor-pointer
              disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Download className="w-3.5 h-3.5" />}
            PNG
          </button>
        </div>
      </div>

      {/* Segment tabs */}
      {segments.length > 0 && (
        <div className="flex items-center border-b border-zinc-800 px-2 shrink-0 bg-zinc-950 overflow-x-auto">
          {segments.map(seg => (
            <button
              key={seg.id}
              onClick={() => handleSegment(seg.id)}
              className={`px-4 py-2 text-xs font-medium border-b-2 transition-colors cursor-pointer whitespace-nowrap
                ${activeSegId === seg.id ? "border-indigo-500 text-white" : "border-transparent text-zinc-500 hover:text-zinc-300"}`}
            >
              {seg.label}
            </button>
          ))}
        </div>
      )}

      {/* Canvas + colorbar */}
      <div className="flex-1 overflow-hidden flex items-center justify-center gap-3 p-4 bg-zinc-950 min-h-0">
        {loading ? (
          <div className="flex items-center gap-2 text-zinc-500 text-sm">
            <div className="w-4 h-4 border-2 border-zinc-600 border-t-indigo-400 rounded-full animate-spin" />
            Loading data…
          </div>
        ) : (
          <>
            <div
              className="relative border border-zinc-700 rounded shadow-2xl"
              style={{ aspectRatio: `${PAPER_W}/${PAPER_H}`, maxHeight: "100%", maxWidth: "100%", height: "100%" }}
            >
              <canvas
                ref={setCanvas}
                width={PAPER_W}
                height={PAPER_H}
                className="w-full h-full rounded"
              />
              {emptyMsg && (
                <div className="absolute inset-0 flex items-center justify-center pointer-events-none p-6">
                  <div className="bg-zinc-900/90 rounded-lg px-5 py-4 text-center border border-zinc-700 max-w-xs">
                    <p className="text-sm text-zinc-300">{emptyMsg}</p>
                  </div>
                </div>
              )}
            </div>
            <Colorbar mode={mode} metric={aoiMetric} max={aoiMax} />
          </>
        )}
      </div>

      {/* Footer counts */}
      <div className="shrink-0 border-t border-zinc-800 bg-zinc-900 px-4 py-1.5 text-[11px] text-zinc-500 flex items-center gap-4">
        {mode === "heatmap" && <span>{gazePts.length} gaze points</span>}
        {mode === "scanpath" && <span>{segFix.length} fixations</span>}
        {mode === "aoi" && <span>{areas.length} areas · {segFix.length} fixations</span>}
        <span className="ml-auto text-zinc-600">1 recording · project overlay coming soon</span>
      </div>
    </div>
  );
}
