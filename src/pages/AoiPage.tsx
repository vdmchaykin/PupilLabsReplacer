import { useState, useRef, useEffect, useCallback } from "react";
import {
  Plus, Eye, EyeOff, Trash2, MousePointer2, Square, Circle,
  Pencil, Eraser, Minus, ChevronRight, ScanLine, Loader2,
  CheckCircle2, AlertCircle, CalendarClock, ArrowLeft, Save,
  Play, Pause, Volume2, VolumeX,
} from "lucide-react";
import { api } from "@/lib/api";
import { formatDuration, formatDate } from "@/lib/utils";
import type { RecordingMeta } from "@/types";

// ─── Types ────────────────────────────────────────────────────────────────────

interface AoiShape {
  kind: "rect" | "ellipse";
  x: number;
  y: number;
  w: number;
  h: number;
}

interface AoiArea {
  id: string;
  name: string;
  color: string;
  visible: boolean;
  shape: AoiShape | null;
}

type DrawingTool = "select" | "rectangle" | "ellipse" | "polygon" | "erase" | "subtract";
type AoiStep = "recording" | "frame" | "draw";

interface DetectResult {
  tag_count: number;
  frame_b64: string;
  warped_image_b64: string | null;
  timestamp_s: number;
  success: boolean;
}

interface AoiState {
  areas: AoiArea[];
  reference_timestamp_s: number | null;
  warped_image_b64: string | null;
  tag_count: number | null;
}

const PALETTE = [
  "#f87171", "#fb923c", "#fbbf24", "#4ade80",
  "#34d399", "#22d3ee", "#60a5fa", "#a78bfa",
  "#f472b6", "#94a3b8", "#e879f9", "#facc15",
  "#f43f5e", "#10b981", "#3b82f6", "#8b5cf6",
];

const API_BASE = "http://localhost:8765";

// ─── Main page ────────────────────────────────────────────────────────────────

export function AoiPage() {
  const [step, setStep] = useState<AoiStep>("recording");
  const [recording, setRecording] = useState<RecordingMeta | null>(null);
  const [warpedImage, setWarpedImage] = useState<string | null>(null);
  const [refTimestamp, setRefTimestamp] = useState<number | null>(null);
  const [areas, setAreas] = useState<AoiArea[]>([]);
  const [tagCount, setTagCount] = useState<number | null>(null);

  const handleSelectRecording = async (rec: RecordingMeta) => {
    setRecording(rec);
    // Try to load existing state
    try {
      const state = await api.get<AoiState>(`/api/recordings/${rec.id}/aoi/state`);
      if (state.warped_image_b64) {
        setWarpedImage(state.warped_image_b64);
        setRefTimestamp(state.reference_timestamp_s);
        setAreas(state.areas ?? []);
        setTagCount(state.tag_count ?? null);
        setStep("draw");
        return;
      }
    } catch {
      // no saved state, continue to frame step
    }
    setWarpedImage(null);
    setRefTimestamp(null);
    setAreas([]);
    setTagCount(null);
    setStep("frame");
  };

  const handleFrameConfirmed = (result: DetectResult) => {
    setWarpedImage(result.warped_image_b64);
    setRefTimestamp(result.timestamp_s);
    setTagCount(result.tag_count);
    setStep("draw");
  };

  const handleSave = async () => {
    if (!recording) return;
    await api.post(`/api/recordings/${recording.id}/aoi/state`, {
      areas,
      reference_timestamp_s: refTimestamp,
      warped_image_b64: warpedImage,
      tag_count: tagCount,
    });
  };

  if (step === "recording") {
    return <RecordingPicker onSelect={handleSelectRecording} />;
  }

  if (step === "frame" && recording) {
    return (
      <FramePicker
        recording={recording}
        onConfirmed={handleFrameConfirmed}
        onBack={() => setStep("recording")}
      />
    );
  }

  if (step === "draw" && recording) {
    return (
      <DrawCanvas
        recording={recording}
        warpedImage={warpedImage}
        refTimestamp={refTimestamp}
        tagCount={tagCount}
        areas={areas}
        setAreas={setAreas}
        onRedetect={() => setStep("frame")}
        onBack={() => setStep("recording")}
        onSave={handleSave}
      />
    );
  }

  return null;
}

// ─── Step 1: Recording picker ─────────────────────────────────────────────────

function RecordingPicker({ onSelect }: { onSelect: (r: RecordingMeta) => void }) {
  const [recordings, setRecordings] = useState<RecordingMeta[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api.get<RecordingMeta[]>("/api/recordings")
      .then(setRecordings)
      .finally(() => setLoading(false));
  }, []);

  return (
    <div className="flex h-full">
      <div className="w-80 border-r border-zinc-800 flex flex-col">
        <div className="px-6 py-3 border-b border-zinc-800">
          <span className="text-sm font-medium text-white">Select a Recording</span>
        </div>
        <div className="flex-1 overflow-auto">
          {loading ? (
            <p className="text-zinc-500 text-xs p-4">Loading…</p>
          ) : recordings.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-12 text-zinc-600">
              <CalendarClock className="w-8 h-8 mb-2 opacity-30" />
              <p className="text-xs">No recordings yet</p>
            </div>
          ) : (
            recordings.map((rec) => (
              <button
                key={rec.id}
                onClick={() => onSelect(rec)}
                className="w-full flex items-center gap-3 px-4 py-3 text-left
                           border-b border-zinc-800/50 hover:bg-zinc-900 transition-colors
                           cursor-pointer"
              >
                <CalendarClock className="w-4 h-4 text-indigo-400 shrink-0" />
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
        <p className="text-sm">Select a recording to define Areas of Interest</p>
      </div>
    </div>
  );
}

// ─── Step 2: Frame picker ─────────────────────────────────────────────────────

function formatTime(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

function FramePicker({
  recording,
  onConfirmed,
  onBack,
}: {
  recording: RecordingMeta;
  onConfirmed: (r: DetectResult) => void;
  onBack: () => void;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [playing, setPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [muted, setMuted] = useState(true);
  const [speed, setSpeed] = useState(1);
  const [detecting, setDetecting] = useState(false);
  const [result, setResult] = useState<DetectResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const videoUrl = `${API_BASE}/api/recordings/${recording.id}/video/scene`;
  const progress = duration > 0 ? (currentTime / duration) * 100 : 0;

  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    const onTime = () => setCurrentTime(v.currentTime);
    const onMeta = () => setDuration(v.duration);
    const onPlay = () => setPlaying(true);
    const onPause = () => setPlaying(false);
    v.addEventListener("timeupdate", onTime);
    v.addEventListener("loadedmetadata", onMeta);
    v.addEventListener("play", onPlay);
    v.addEventListener("pause", onPause);
    return () => {
      v.removeEventListener("timeupdate", onTime);
      v.removeEventListener("loadedmetadata", onMeta);
      v.removeEventListener("play", onPlay);
      v.removeEventListener("pause", onPause);
    };
  }, []);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement).tagName;
      if (tag === "INPUT" || tag === "TEXTAREA") return;
      const v = videoRef.current;
      if (!v) return;
      if (e.code === "Space") { e.preventDefault(); v.paused ? v.play() : v.pause(); }
      else if (e.code === "ArrowRight") { e.preventDefault(); v.currentTime = Math.min(v.currentTime + 1, v.duration); }
      else if (e.code === "ArrowLeft")  { e.preventDefault(); v.currentTime = Math.max(v.currentTime - 1, 0); }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  const toggle = () => { const v = videoRef.current; if (!v) return; v.paused ? v.play() : v.pause(); };

  const handleSeek = (e: React.ChangeEvent<HTMLInputElement>) => {
    const t = parseFloat(e.target.value);
    if (videoRef.current) videoRef.current.currentTime = t;
    setCurrentTime(t);
  };

  const handleDetect = async () => {
    const t = videoRef.current?.currentTime ?? 0;
    setDetecting(true);
    setError(null);
    setResult(null);
    try {
      const res = await api.post<DetectResult>(
        `/api/recordings/${recording.id}/aoi/detect-frame`,
        { timestamp_s: t },
      );
      setResult(res);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Detection failed");
    } finally {
      setDetecting(false);
    }
  };

  const tagBadgeClass =
    !result ? ""
    : result.tag_count >= 4 ? "bg-emerald-900/60 text-emerald-300 border-emerald-700"
    : result.tag_count === 3 ? "bg-yellow-900/60 text-yellow-300 border-yellow-700"
    : "bg-red-900/60 text-red-300 border-red-700";

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Header */}
      <div className="flex items-center gap-3 px-4 h-11 border-b border-zinc-800 shrink-0">
        <button
          onClick={onBack}
          className="text-xs text-zinc-400 hover:text-white transition-colors cursor-pointer"
        >
          ← All Recordings
        </button>
        <span className="text-zinc-700">|</span>
        <span className="text-sm font-medium text-white">{recording.name}</span>
        {recording.wearer_name && (
          <span className="text-xs text-zinc-500">{recording.wearer_name}</span>
        )}
        <span className="text-xs text-zinc-600 ml-auto">
          Pause on a frame with 3–4 AprilTags visible, then click Detect
        </span>
      </div>

      {/* Body: player (left) + result panel (right) */}
      <div className="flex flex-1 min-h-0">
        {/* Player */}
        <div className="flex flex-col flex-1 min-w-0 bg-black">
          {/* Video area */}
          <div className="relative flex-1 overflow-hidden cursor-pointer" onClick={toggle}>
            <video
              ref={videoRef}
              src={videoUrl}
              className="w-full h-full object-contain"
              muted={muted}
              playsInline
              preload="metadata"
            />
            {!playing && (
              <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
                <div className="w-14 h-14 rounded-full bg-black/40 flex items-center justify-center">
                  <Play className="w-7 h-7 text-white ml-1" />
                </div>
              </div>
            )}
          </div>

          {/* Controls */}
          <div className="flex flex-col gap-2 px-3 py-2.5 bg-zinc-900 border-t border-zinc-800 shrink-0">
            {/* Seekbar */}
            <div className="relative h-1.5">
              <div className="absolute inset-0 bg-zinc-700 rounded-full" />
              <div
                className="absolute inset-y-0 left-0 bg-indigo-500 rounded-full pointer-events-none"
                style={{ width: `${progress}%` }}
              />
              <input
                type="range" min={0} max={duration || 0} step={0.05} value={currentTime}
                onChange={handleSeek}
                className="absolute inset-0 w-full opacity-0 cursor-pointer h-full"
              />
            </div>

            {/* Buttons row */}
            <div className="flex items-center gap-2">
              <button onClick={toggle} className="text-white hover:text-indigo-400 transition-colors cursor-pointer">
                {playing ? <Pause className="w-4 h-4" /> : <Play className="w-4 h-4" />}
              </button>
              <button
                onClick={() => { const n = !muted; setMuted(n); if (videoRef.current) videoRef.current.muted = n; }}
                className="text-zinc-400 hover:text-white transition-colors cursor-pointer"
              >
                {muted ? <VolumeX className="w-4 h-4" /> : <Volume2 className="w-4 h-4" />}
              </button>
              <span className="text-xs text-zinc-400 tabular-nums">
                {formatTime(currentTime)} / {formatTime(duration)}
              </span>
              <div className="flex-1" />
              {[0.1, 0.25, 0.5, 1, 2].map((s) => (
                <button
                  key={s}
                  onClick={() => { setSpeed(s); if (videoRef.current) videoRef.current.playbackRate = s; }}
                  className={`text-xs px-1.5 py-0.5 rounded transition-colors cursor-pointer
                    ${speed === s ? "bg-indigo-600 text-white" : "text-zinc-400 hover:text-white"}`}
                >
                  {s}×
                </button>
              ))}
              <div className="w-px h-4 bg-zinc-700 mx-1" />
              <button
                onClick={handleDetect}
                disabled={detecting}
                className="flex items-center gap-1.5 px-3 py-1 bg-indigo-600 hover:bg-indigo-500
                           disabled:opacity-50 disabled:cursor-not-allowed text-white text-xs
                           rounded transition-colors cursor-pointer font-medium"
              >
                {detecting ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <ScanLine className="w-3.5 h-3.5" />}
                {detecting ? "Detecting…" : "Detect AprilTags"}
              </button>
            </div>
          </div>
        </div>

        {/* Result panel */}
        <div className="w-80 shrink-0 border-l border-zinc-800 flex flex-col overflow-auto bg-zinc-950">
          <div className="px-4 py-3 border-b border-zinc-800">
            <span className="text-xs font-medium text-zinc-400">Detection result</span>
          </div>

          <div className="flex flex-col gap-3 p-4">
            {error && (
              <div className="flex items-center gap-2 text-sm text-red-400 bg-red-950/40
                              border border-red-800 rounded-lg px-3 py-2">
                <AlertCircle className="w-4 h-4 shrink-0" />
                {error}
              </div>
            )}

            {result && (
              <>
                <div className={`flex items-center gap-2 text-sm border rounded-lg px-3 py-2 ${tagBadgeClass}`}>
                  {result.tag_count >= 3
                    ? <CheckCircle2 className="w-4 h-4 shrink-0" />
                    : <AlertCircle className="w-4 h-4 shrink-0" />}
                  <span>
                    <strong>{result.tag_count}</strong> AprilTag{result.tag_count !== 1 ? "s" : ""} detected
                    {result.tag_count < 3 && " — need at least 3"}
                    {result.tag_count === 3 && " — warp may be approximate"}
                  </span>
                </div>

                <div className="rounded-lg overflow-hidden border border-zinc-800">
                  <img src={`data:image/jpeg;base64,${result.frame_b64}`} alt="Detected frame" className="w-full" />
                </div>

                {result.warped_image_b64 && (
                  <div>
                    <p className="text-xs text-zinc-500 mb-1.5">Warped paper preview</p>
                    <div className="rounded-lg overflow-hidden border border-zinc-700">
                      <img src={`data:image/jpeg;base64,${result.warped_image_b64}`} alt="Warped paper" className="w-full" />
                    </div>
                  </div>
                )}

                {result.success && (
                  <button
                    onClick={() => onConfirmed(result)}
                    className="flex items-center justify-center gap-2 px-4 py-2.5
                               bg-emerald-700 hover:bg-emerald-600 text-white text-sm
                               rounded-lg transition-colors cursor-pointer font-medium"
                  >
                    Use this frame
                    <ChevronRight className="w-4 h-4" />
                  </button>
                )}
              </>
            )}

            {!result && !error && (
              <p className="text-zinc-700 text-xs text-center py-8 px-2">
                Click "Detect AprilTags" to analyse the current frame
              </p>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── Step 3: AoI drawing canvas ───────────────────────────────────────────────

function DrawCanvas({
  recording,
  warpedImage,
  refTimestamp,
  tagCount,
  areas,
  setAreas,
  onRedetect,
  onBack,
  onSave,
}: {
  recording: RecordingMeta;
  warpedImage: string | null;
  refTimestamp: number | null;
  tagCount: number | null;
  areas: AoiArea[];
  setAreas: React.Dispatch<React.SetStateAction<AoiArea[]>>;
  onRedetect: () => void;
  onBack: () => void;
  onSave: () => Promise<void>;
}) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [tool, setTool] = useState<DrawingTool>("select");
  const [drawStart, setDrawStart] = useState<{ x: number; y: number } | null>(null);
  const [liveBox, setLiveBox] = useState<AoiShape | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveOk, setSaveOk] = useState(false);

  const paperRef = useRef<HTMLDivElement>(null);

  const addArea = useCallback((defaultTool: DrawingTool = "rectangle") => {
    const id = crypto.randomUUID();
    setAreas((prev) => [
      ...prev,
      { id, name: `Area ${prev.length + 1}`, color: PALETTE[prev.length % PALETTE.length], visible: true, shape: null },
    ]);
    setSelectedId(id);
    setTool(defaultTool);
  }, [setAreas]);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement).tagName === "INPUT") return;
      if (e.key === "a" || e.key === "A") addArea("ellipse");
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [addArea]);

  const toggleVisible = (id: string) =>
    setAreas((prev) => prev.map((a) => (a.id === id ? { ...a, visible: !a.visible } : a)));

  const deleteArea = (id: string) => {
    setAreas((prev) => prev.filter((a) => a.id !== id));
    if (selectedId === id) setSelectedId(null);
  };

  const startRename = (area: AoiArea) => { setEditingId(area.id); setEditName(area.name); };

  const commitRename = () => {
    if (editingId) {
      const t = editName.trim();
      if (t) setAreas((prev) => prev.map((a) => (a.id === editingId ? { ...a, name: t } : a)));
    }
    setEditingId(null);
    setEditName("");
  };

  const getPaperCoords = (e: React.MouseEvent) => {
    if (!paperRef.current) return null;
    const r = paperRef.current.getBoundingClientRect();
    return {
      x: Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)),
      y: Math.max(0, Math.min(1, (e.clientY - r.top) / r.height)),
    };
  };

  const isDrawing = tool === "rectangle" || tool === "ellipse";

  const onMouseDown = (e: React.MouseEvent) => {
    const pt = getPaperCoords(e);
    if (!pt) return;
    if (tool === "select") {
      const clicked = [...areas].reverse().find((a) => {
        if (!a.visible || !a.shape) return false;
        const { x, y, w, h } = a.shape;
        return pt.x >= x && pt.x <= x + w && pt.y >= y && pt.y <= y + h;
      });
      setSelectedId(clicked?.id ?? null);
      return;
    }
    if (isDrawing) {
      setDrawStart(pt);
      setLiveBox({ kind: tool === "ellipse" ? "ellipse" : "rect", x: pt.x, y: pt.y, w: 0, h: 0 });
      e.preventDefault();
    }
  };

  const onMouseMove = (e: React.MouseEvent) => {
    if (!drawStart || !isDrawing) return;
    const pt = getPaperCoords(e);
    if (!pt) return;
    setLiveBox({
      kind: tool === "ellipse" ? "ellipse" : "rect",
      x: Math.min(drawStart.x, pt.x),
      y: Math.min(drawStart.y, pt.y),
      w: Math.abs(pt.x - drawStart.x),
      h: Math.abs(pt.y - drawStart.y),
    });
  };

  const onMouseUp = () => {
    if (!drawStart || !liveBox) return;
    if (liveBox.w > 0.01 && liveBox.h > 0.01 && selectedId) {
      setAreas((prev) => prev.map((a) => (a.id === selectedId ? { ...a, shape: { ...liveBox } } : a)));
    }
    setDrawStart(null);
    setLiveBox(null);
    setTool("select");
  };

  const handleSave = async () => {
    setSaving(true);
    setSaveOk(false);
    try {
      await onSave();
      setSaveOk(true);
      setTimeout(() => setSaveOk(false), 2000);
    } finally {
      setSaving(false);
    }
  };

  const selectedArea = areas.find((a) => a.id === selectedId);

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Header */}
      <div className="flex items-center gap-3 px-4 h-11 border-b border-zinc-800 shrink-0">
        <button
          onClick={onBack}
          className="text-xs text-zinc-400 hover:text-white transition-colors cursor-pointer"
        >
          ← All Recordings
        </button>
        <span className="text-zinc-700">|</span>
        <span className="text-sm font-medium text-white">{recording.name}</span>
        {recording.wearer_name && (
          <span className="text-xs text-zinc-500">{recording.wearer_name}</span>
        )}
      </div>

      <div className="flex flex-1 min-h-0 overflow-hidden">
      {/* Left panel: area list */}
      <div className="w-52 border-r border-zinc-800 flex flex-col shrink-0 bg-zinc-950">
        <div className="flex items-center justify-between px-4 py-2.5 border-b border-zinc-800">
          <div className="min-w-0">
            {refTimestamp !== null && (
              <span className="text-xs text-zinc-500">@ {refTimestamp.toFixed(2)}s</span>
            )}
          </div>
          <button
            onClick={() => addArea("ellipse")}
            className="shrink-0 flex items-center gap-1 px-2 py-1 bg-indigo-600 hover:bg-indigo-500
                       text-white text-xs rounded-md transition-colors cursor-pointer ml-2"
            title="Add area (A)"
          >
            <Plus className="w-3 h-3" />
            Add
          </button>
        </div>

        <div className="flex-1 overflow-auto">
          {areas.length === 0 ? (
            <p className="text-xs text-center text-zinc-700 px-4 py-8 leading-relaxed">
              Click "+ Add" to define an Area of Interest
            </p>
          ) : (
            areas.map((area) => (
              <div
                key={area.id}
                onClick={() => { if (editingId !== area.id) setSelectedId(area.id); }}
                className={`flex items-center gap-2 px-3 py-2 cursor-pointer group
                            border-b border-zinc-800/40 transition-colors
                            ${selectedId === area.id ? "bg-zinc-800" : "hover:bg-zinc-900/60"}`}
              >
                <button
                  onClick={(e) => { e.stopPropagation(); toggleVisible(area.id); }}
                  className={`shrink-0 cursor-pointer transition-colors
                    ${area.visible ? "text-zinc-400 hover:text-zinc-200" : "text-zinc-700 hover:text-zinc-500"}`}
                >
                  {area.visible ? <Eye className="w-3.5 h-3.5" /> : <EyeOff className="w-3.5 h-3.5" />}
                </button>
                <div className="w-3 h-3 rounded-sm shrink-0 border border-white/10" style={{ backgroundColor: area.color }} />
                {editingId === area.id ? (
                  <input
                    autoFocus
                    value={editName}
                    onChange={(e) => setEditName(e.target.value)}
                    onBlur={commitRename}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") commitRename();
                      if (e.key === "Escape") { setEditingId(null); setEditName(""); }
                      e.stopPropagation();
                    }}
                    onClick={(e) => e.stopPropagation()}
                    className="flex-1 min-w-0 bg-zinc-700 text-white text-xs px-1.5 py-0.5
                               rounded border border-zinc-500 focus:border-indigo-500 outline-none"
                  />
                ) : (
                  <span
                    className="text-xs text-zinc-300 flex-1 truncate"
                    onDoubleClick={(e) => { e.stopPropagation(); startRename(area); }}
                    title="Double-click to rename"
                  >
                    {area.name}
                  </span>
                )}
                <button
                  onClick={(e) => { e.stopPropagation(); deleteArea(area.id); }}
                  className="opacity-0 group-hover:opacity-100 shrink-0 text-zinc-600
                             hover:text-red-400 cursor-pointer transition-all"
                >
                  <Trash2 className="w-3 h-3" />
                </button>
              </div>
            ))
          )}
        </div>

        {/* Bottom actions */}
        <div className="border-t border-zinc-800 p-3 flex flex-col gap-2">
          <button
            onClick={handleSave}
            disabled={saving}
            className="flex items-center justify-center gap-2 px-3 py-1.5 w-full
                       bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50
                       text-white text-xs rounded-md transition-colors cursor-pointer"
          >
            {saving ? <Loader2 className="w-3 h-3 animate-spin" /> : <Save className="w-3 h-3" />}
            {saveOk ? "Saved!" : saving ? "Saving…" : "Save"}
          </button>
          <button
            onClick={onRedetect}
            className="flex items-center justify-center gap-1.5 px-3 py-1.5 w-full
                       text-zinc-500 hover:text-white text-xs rounded-md
                       hover:bg-zinc-800 transition-colors cursor-pointer"
          >
            <ScanLine className="w-3 h-3" />
            Re-detect frame
          </button>
        </div>
      </div>

      {/* Right: toolbar + canvas */}
      <div className="flex-1 flex flex-col min-w-0 bg-zinc-950">
        {/* Toolbar */}
        <div className="flex items-center gap-1.5 px-4 py-2 border-b border-zinc-800 shrink-0">
          <ToolButton active={tool === "select"} onClick={() => setTool("select")} title="Select (V)">
            <MousePointer2 className="w-4 h-4" />
          </ToolButton>
          <ToolButton active={tool === "rectangle"} onClick={() => setTool("rectangle")} title="Draw rectangle">
            <Square className="w-4 h-4" />
          </ToolButton>
          <ToolButton active={tool === "ellipse"} onClick={() => setTool("ellipse")} title="Draw ellipse (A)">
            <Circle className="w-4 h-4" />
          </ToolButton>
          <ToolButton active={tool === "polygon"} onClick={() => {}} title="Polygon — coming soon" disabled>
            <Pencil className="w-4 h-4" />
          </ToolButton>
          <ToolButton active={tool === "subtract"} onClick={() => {}} title="Subtract — coming soon" disabled>
            <Minus className="w-4 h-4" />
          </ToolButton>
          <ToolButton active={tool === "erase"} onClick={() => {}} title="Erase — coming soon" disabled>
            <Eraser className="w-4 h-4" />
          </ToolButton>
          <div className="w-px h-5 bg-zinc-700 mx-1" />
          <button
            onClick={() => { setAreas([]); setSelectedId(null); }}
            disabled={areas.length === 0}
            className="px-3 py-1 text-xs text-zinc-500 hover:text-white
                       disabled:opacity-30 disabled:cursor-not-allowed cursor-pointer transition-colors rounded"
          >
            Clear all
          </button>
          {tagCount !== null && (
            <span className={`ml-auto text-xs px-2 py-0.5 rounded border
              ${tagCount >= 4
                ? "text-emerald-400 border-emerald-800 bg-emerald-950/40"
                : "text-yellow-400 border-yellow-800 bg-yellow-950/40"}`}>
              {tagCount} tags
            </span>
          )}
        </div>

        {/* Paper canvas */}
        <div className="flex-1 flex items-center justify-center overflow-hidden p-8">
          <div
            className="relative shadow-2xl overflow-hidden flex-shrink-0"
            style={{ aspectRatio: "794 / 1123", height: "calc(100% - 16px)" }}
          >
            {/* Background: warped image or white paper */}
            {warpedImage ? (
              <img
                src={`data:image/jpeg;base64,${warpedImage}`}
                alt="Warped paper"
                className="absolute inset-0 w-full h-full object-fill pointer-events-none select-none"
                draggable={false}
              />
            ) : (
              <div className="absolute inset-0 bg-white" />
            )}

            {/* Empty state hint */}
            {areas.every((a) => !a.shape) && (
              <div className="absolute inset-0 flex items-center justify-center pointer-events-none z-10">
                <p className="text-white/30 text-sm select-none text-center px-8 drop-shadow">
                  {(tool === "rectangle" || tool === "ellipse") && selectedId
                    ? "Click and drag to place the area"
                    : "Select an area, pick a shape tool, then drag"}
                </p>
              </div>
            )}

            {/* Drawing surface */}
            <div
              ref={paperRef}
              className="absolute inset-0 z-20"
              style={{ cursor: isDrawing ? "crosshair" : "default" }}
              onMouseDown={onMouseDown}
              onMouseMove={onMouseMove}
              onMouseUp={onMouseUp}
              onMouseLeave={() => { setDrawStart(null); setLiveBox(null); }}
            />

            {/* SVG overlays */}
            <svg className="absolute inset-0 w-full h-full z-20" style={{ pointerEvents: "none" }}>
              {areas.map((area) => {
                if (!area.visible || !area.shape) return null;
                return (
                  <ShapeOverlay
                    key={area.id}
                    shape={area.shape}
                    color={area.color}
                    label={area.name}
                    selected={area.id === selectedId}
                  />
                );
              })}
              {liveBox && selectedArea && (
                <ShapeOverlay shape={liveBox} color={selectedArea.color} label="" selected={false} preview />
              )}
            </svg>
          </div>
        </div>
      </div>
      </div>
    </div>
  );
}

// ─── Shared sub-components ────────────────────────────────────────────────────

function ShapeOverlay({
  shape, color, label, selected, preview = false,
}: {
  shape: AoiShape;
  color: string;
  label: string;
  selected: boolean;
  preview?: boolean;
}) {
  const { kind, x, y, w, h } = shape;
  const cx = (x + w / 2) * 100;
  const cy = (y + h / 2) * 100;
  const fill = { fill: color, fillOpacity: preview ? 0.18 : 0.3 };
  const stroke = { stroke: color, strokeWidth: selected ? 2.5 : 1.5, strokeDasharray: preview ? "5 3" : undefined };

  return (
    <g>
      {kind === "rect" ? (
        <rect x={`${x * 100}%`} y={`${y * 100}%`} width={`${w * 100}%`} height={`${h * 100}%`} rx={3} {...fill} {...stroke} />
      ) : (
        <ellipse cx={`${cx}%`} cy={`${cy}%`} rx={`${(w / 2) * 100}%`} ry={`${(h / 2) * 100}%`} {...fill} {...stroke} />
      )}
      {selected && !preview && kind === "rect" && (
        <rect x={`${x * 100}%`} y={`${y * 100}%`} width={`${w * 100}%`} height={`${h * 100}%`}
          fill="none" stroke="white" strokeWidth={0.8} strokeDasharray="4 3" rx={3} />
      )}
      {selected && !preview && kind === "ellipse" && (
        <ellipse cx={`${cx}%`} cy={`${cy}%`} rx={`${(w / 2) * 100}%`} ry={`${(h / 2) * 100}%`}
          fill="none" stroke="white" strokeWidth={0.8} strokeDasharray="4 3" />
      )}
      {!preview && label && (
        <text x={`${cx}%`} y={`${cy}%`} textAnchor="middle" dominantBaseline="middle"
          fill={color} fontSize={13} fontWeight="700" style={{ userSelect: "none" }}>
          {label}
        </text>
      )}
    </g>
  );
}

function ToolButton({
  active, onClick, title, disabled, children,
}: {
  active: boolean;
  onClick: () => void;
  title: string;
  disabled?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={title}
      className={`p-1.5 rounded transition-colors cursor-pointer
        disabled:opacity-30 disabled:cursor-not-allowed
        ${active ? "bg-indigo-600 text-white" : "text-zinc-400 hover:bg-zinc-800 hover:text-white"}`}
    >
      {children}
    </button>
  );
}
