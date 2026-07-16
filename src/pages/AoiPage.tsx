import { useState, useRef, useEffect, useCallback } from "react";
import {
  Plus, Eye, EyeOff, Trash2, MousePointer2, Square, Circle,
  Pencil, ChevronRight, ScanLine, Loader2,
  CheckCircle2, AlertCircle, CalendarClock, Save,
  Play, Pause, Volume2, VolumeX,
} from "lucide-react";
import { api } from "@/lib/api";
import { formatDuration, formatDate } from "@/lib/utils";
import { confirmDialog } from "@/components/ConfirmDialog";
import type { RecordingMeta, RecordingEvent } from "@/types";

// ─── Types ────────────────────────────────────────────────────────────────────

interface AoiShape {
  kind: "rect" | "ellipse" | "polygon";
  x: number;
  y: number;
  w: number;
  h: number;
  points?: [number, number][];  // normalized [0,1] coords, only for polygon
}

interface AoiArea {
  id: string;
  name: string;
  color: string;
  visible: boolean;
  shape: AoiShape | null;
}

type DrawingTool = "select" | "rectangle" | "ellipse" | "polygon";

interface AoiSegmentMeta {
  id: string;
  label: string;
  eventPrefix: string | null;
}

interface SegmentData {
  loaded: boolean;
  loading: boolean;
  warpedImage: string | null;
  refTimestamp: number | null;
  areas: AoiArea[];
  tagCount: number | null;
}

interface TagInfo {
  index: number;
  tag_id: number;
  center: [number, number];
  corners: [[number, number], [number, number], [number, number], [number, number]];
}

interface DetectResult {
  tag_count: number;
  frame_b64: string;
  warped_image_b64: string | null;
  timestamp_s: number;
  success: boolean;
  frame_width: number;
  frame_height: number;
  tags: TagInfo[];
}

const PALETTE = [
  "#f87171", "#fb923c", "#fbbf24", "#4ade80",
  "#34d399", "#22d3ee", "#60a5fa", "#a78bfa",
  "#f472b6", "#94a3b8", "#e879f9", "#facc15",
  "#f43f5e", "#10b981", "#3b82f6", "#8b5cf6",
];

const API_BASE = "http://localhost:8765";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function formatSegmentLabel(id: string): string {
  return id.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

function deriveSegments(events: RecordingEvent[]): AoiSegmentMeta[] {
  const prefixes = new Set<string>();
  for (const ev of events) {
    const m = ev.name.match(/^(.+)_begin$/);
    if (m) prefixes.add(m[1]);
  }
  const result: AoiSegmentMeta[] = Array.from(prefixes)
    .sort()
    .map((prefix) => ({ id: prefix, label: formatSegmentLabel(prefix), eventPrefix: prefix }));
  result.push({ id: "general", label: "General", eventPrefix: null });
  return result;
}

const emptySegmentData = (): SegmentData => ({
  loaded: false,
  loading: false,
  warpedImage: null,
  refTimestamp: null,
  areas: [],
  tagCount: null,
});

// ─── Main page ────────────────────────────────────────────────────────────────

export function AoiPage({ initialRecording }: { initialRecording?: RecordingMeta }) {
  const [step, setStep] = useState<"recording" | "annotate">(
    initialRecording ? "annotate" : "recording"
  );
  const [recording, setRecording] = useState<RecordingMeta | null>(initialRecording ?? null);
  const [segments, setSegments] = useState<AoiSegmentMeta[]>([]);
  const [activeSegmentId, setActiveSegmentId] = useState<string>("general");
  const [segmentData, setSegmentData] = useState<Record<string, SegmentData>>({});

  const loadSegmentState = useCallback(async (recordingId: string, segmentId: string) => {
    setSegmentData((prev) => ({
      ...prev,
      [segmentId]: { ...(prev[segmentId] ?? emptySegmentData()), loading: true },
    }));
    try {
      const state = await api.get<{
        areas: AoiArea[];
        reference_timestamp_s: number | null;
        warped_image_b64: string | null;
        tag_count: number | null;
      }>(`/api/recordings/${recordingId}/aoi/${segmentId}/state`);
      setSegmentData((prev) => ({
        ...prev,
        [segmentId]: {
          loaded: true,
          loading: false,
          warpedImage: state.warped_image_b64 ?? null,
          refTimestamp: state.reference_timestamp_s ?? null,
          areas: state.areas ?? [],
          tagCount: state.tag_count ?? null,
        },
      }));
    } catch {
      setSegmentData((prev) => ({
        ...prev,
        [segmentId]: { ...emptySegmentData(), loaded: true },
      }));
    }
  }, []);

  const loadSegments = useCallback(async (recordingId: string): Promise<AoiSegmentMeta[]> => {
    let eventSegs: AoiSegmentMeta[] = [{ id: "general", label: "General", eventPrefix: null }];
    try {
      const evs = await api.get<RecordingEvent[]>(`/api/recordings/${recordingId}/events`);
      eventSegs = deriveSegments(evs);
    } catch { /* no events yet */ }

    try {
      const manifest = await api.get<{ custom_segments: { id: string; label: string }[] }>(
        `/api/recordings/${recordingId}/aoi/segments`
      );
      const eventIds = new Set(eventSegs.map((s) => s.id));
      for (const cs of manifest.custom_segments) {
        if (!eventIds.has(cs.id)) {
          eventSegs.push({ id: cs.id, label: cs.label, eventPrefix: null });
        }
      }
    } catch { /* no manifest yet */ }

    return eventSegs;
  }, []);

  const saveSegmentsManifest = useCallback(async (recordingId: string, segs: AoiSegmentMeta[]) => {
    const custom = segs.filter((s) => s.eventPrefix === null && s.id !== "general");
    await api.post(`/api/recordings/${recordingId}/aoi/segments`, {
      custom_segments: custom.map((s) => ({ id: s.id, label: s.label })),
    });
  }, []);

  useEffect(() => {
    if (!initialRecording) return;
    (async () => {
      const segs = await loadSegments(initialRecording.id);
      setSegments(segs);
      setActiveSegmentId(segs[0].id);
      await loadSegmentState(initialRecording.id, segs[0].id);
    })();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleSelectRecording = async (rec: RecordingMeta) => {
    setRecording(rec);
    setSegmentData({});
    const segs = await loadSegments(rec.id);
    setSegments(segs);
    setActiveSegmentId(segs[0].id);
    setStep("annotate");
    await loadSegmentState(rec.id, segs[0].id);
  };

  const handleTabChange = async (segId: string) => {
    setActiveSegmentId(segId);
    if (!segmentData[segId]?.loaded && !segmentData[segId]?.loading) {
      await loadSegmentState(recording!.id, segId);
    }
  };

  const handleFrameConfirmed = (result: DetectResult) => {
    setSegmentData((prev) => ({
      ...prev,
      [activeSegmentId]: {
        ...(prev[activeSegmentId] ?? emptySegmentData()),
        loaded: true,
        loading: false,
        warpedImage: result.warped_image_b64,
        refTimestamp: result.timestamp_s,
        tagCount: result.tag_count,
      },
    }));
  };

  const handleAreasChange = (areas: AoiArea[]) => {
    setSegmentData((prev) => ({
      ...prev,
      [activeSegmentId]: { ...(prev[activeSegmentId] ?? emptySegmentData()), areas },
    }));
  };

  const handleRedetect = () => {
    setSegmentData((prev) => ({
      ...prev,
      [activeSegmentId]: {
        ...(prev[activeSegmentId] ?? emptySegmentData()),
        warpedImage: null,
        refTimestamp: null,
        tagCount: null,
      },
    }));
  };

  const handleSave = async () => {
    if (!recording) return;
    const data = segmentData[activeSegmentId];
    if (!data) return;
    await api.post(`/api/recordings/${recording.id}/aoi/${activeSegmentId}/state`, {
      areas: data.areas,
      reference_timestamp_s: data.refTimestamp,
      warped_image_b64: data.warpedImage,
      tag_count: data.tagCount,
    });
  };

  const handleAddSegment = async (name: string) => {
    const id = name.trim().toLowerCase().replace(/\s+/g, "_").replace(/[^a-z0-9_-]/g, "").slice(0, 64);
    if (!id || segments.some((s) => s.id === id)) return;
    const newSeg: AoiSegmentMeta = { id, label: name.trim(), eventPrefix: null };
    const updated = [...segments, newSeg];
    setSegments(updated);
    setActiveSegmentId(id);
    await Promise.all([
      loadSegmentState(recording!.id, id),
      saveSegmentsManifest(recording!.id, updated),
    ]);
  };

  if (step === "recording") {
    return <RecordingPicker onSelect={handleSelectRecording} />;
  }

  return (
    <AnnotateView
      recording={recording!}
      segments={segments}
      activeSegmentId={activeSegmentId}
      segmentData={segmentData}
      onTabChange={handleTabChange}
      onBack={() => setStep("recording")}
      onFrameConfirmed={handleFrameConfirmed}
      onAreasChange={handleAreasChange}
      onRedetect={handleRedetect}
      onSave={handleSave}
      onAddSegment={handleAddSegment}
    />
  );
}

// ─── Annotate view: header + tabs + content ───────────────────────────────────

function AnnotateView({
  recording,
  segments,
  activeSegmentId,
  segmentData,
  onTabChange,
  onBack,
  onFrameConfirmed,
  onAreasChange,
  onRedetect,
  onSave,
  onAddSegment,
}: {
  recording: RecordingMeta;
  segments: AoiSegmentMeta[];
  activeSegmentId: string;
  segmentData: Record<string, SegmentData>;
  onTabChange: (id: string) => void;
  onBack: () => void;
  onFrameConfirmed: (r: DetectResult) => void;
  onAreasChange: (areas: AoiArea[]) => void;
  onRedetect: () => void;
  onSave: () => Promise<void>;
  onAddSegment: (name: string) => Promise<void>;
}) {
  const activeData = segmentData[activeSegmentId];
  const [addingTab, setAddingTab] = useState(false);
  const [newTabName, setNewTabName] = useState("");
  const newTabInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (addingTab) newTabInputRef.current?.focus();
  }, [addingTab]);

  const commitNewTab = async () => {
    const name = newTabName.trim();
    setAddingTab(false);
    setNewTabName("");
    if (name) await onAddSegment(name);
  };

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

      {/* Segment tabs */}
      <div className="flex items-center border-b border-zinc-800 px-2 shrink-0 bg-zinc-950">
        {segments.map((seg) => (
          <button
            key={seg.id}
            onClick={() => onTabChange(seg.id)}
            className={`px-4 py-2 text-xs font-medium border-b-2 transition-colors cursor-pointer
              ${activeSegmentId === seg.id
                ? "border-indigo-500 text-white"
                : "border-transparent text-zinc-500 hover:text-zinc-300"}`}
          >
            {seg.label}
          </button>
        ))}
        {addingTab ? (
          <input
            ref={newTabInputRef}
            value={newTabName}
            onChange={(e) => setNewTabName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") commitNewTab();
              if (e.key === "Escape") { setAddingTab(false); setNewTabName(""); }
            }}
            onBlur={commitNewTab}
            placeholder="Tab name…"
            className="mx-1 px-2 py-1 text-xs bg-zinc-800 border border-zinc-600 rounded text-white outline-none w-28"
          />
        ) : (
          <button
            onClick={() => setAddingTab(true)}
            title="Add segment"
            className="ml-1 px-2 py-1 text-zinc-500 hover:text-zinc-200 transition-colors cursor-pointer text-base leading-none"
          >
            +
          </button>
        )}
      </div>

      {/* Content */}
      {!activeData || activeData.loading ? (
        <div className="flex-1 flex items-center justify-center text-zinc-600">
          <Loader2 className="w-6 h-6 animate-spin" />
        </div>
      ) : !activeData.warpedImage ? (
        <FramePicker recording={recording} onConfirmed={onFrameConfirmed} />
      ) : (
        <DrawCanvas
          recording={recording}
          warpedImage={activeData.warpedImage}
          refTimestamp={activeData.refTimestamp}
          tagCount={activeData.tagCount}
          areas={activeData.areas}
          onAreasChange={onAreasChange}
          onRedetect={onRedetect}
          onSave={onSave}
        />
      )}
    </div>
  );
}

// ─── Recording picker ─────────────────────────────────────────────────────────

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

// ─── Frame picker ─────────────────────────────────────────────────────────────

function formatTime(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

function FramePicker({
  recording,
  onConfirmed,
}: {
  recording: RecordingMeta;
  onConfirmed: (r: DetectResult) => void;
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

  // Tag selection state — keyed by detection index, not tag_id (IDs can repeat across papers)
  const [selectedIndices, setSelectedIndices] = useState<Set<number>>(new Set());
  const [warpB64, setWarpB64] = useState<string | null>(null);
  const [warpOk, setWarpOk] = useState(false);
  const [recomputing, setRecomputing] = useState(false);

  // When a new detection result arrives, select all tags by default
  useEffect(() => {
    if (!result) return;
    setSelectedIndices(new Set(result.tags.map((t) => t.index)));
    setWarpB64(result.warped_image_b64);
    setWarpOk(result.success);
  }, [result]);

  const toggleTag = useCallback(async (idx: number) => {
    if (!result) return;
    const newSel = new Set(selectedIndices);
    if (newSel.has(idx)) newSel.delete(idx); else newSel.add(idx);
    setSelectedIndices(newSel);

    const selTags = result.tags.filter((t) => newSel.has(t.index));
    if (selTags.length < 3) { setWarpB64(null); setWarpOk(false); return; }

    setRecomputing(true);
    try {
      const res = await api.post<{ warped_image_b64: string | null; success: boolean }>(
        `/api/recordings/${recording.id}/aoi/warp-from-selection`,
        { timestamp_s: result.timestamp_s, selected_tags: selTags },
      );
      setWarpB64(res.warped_image_b64);
      setWarpOk(res.success);
    } catch { /* keep current preview */ }
    finally { setRecomputing(false); }
  }, [result, selectedIndices, recording.id]);

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
    // Reset result/error when recording changes
    setResult(null);
    setError(null);
  }, [recording.id]);

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

  const selCount = selectedIndices.size;
  const tagBadgeClass =
    !result ? ""
    : selCount >= 4 ? "bg-emerald-900/60 text-emerald-300 border-emerald-700"
    : selCount === 3 ? "bg-yellow-900/60 text-yellow-300 border-yellow-700"
    : "bg-red-900/60 text-red-300 border-red-700";

  return (
    <div className="flex flex-1 min-h-0">
      {/* Player */}
      <div className="flex flex-col flex-1 min-w-0 bg-black">
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
                {selCount >= 3
                  ? <CheckCircle2 className="w-4 h-4 shrink-0" />
                  : <AlertCircle className="w-4 h-4 shrink-0" />}
                <span>
                  <strong>{selCount}</strong>/{result.tag_count} tag{result.tag_count !== 1 ? "s" : ""} selected
                  {selCount < 3 && " — need at least 3"}
                  {selCount === 3 && " — warp may be approximate"}
                </span>
              </div>

              {/* Interactive frame: click a tag to toggle it */}
              <div>
                <p className="text-xs text-zinc-500 mb-1.5">Click a tag to exclude it</p>
                <div className="relative rounded-lg overflow-hidden border border-zinc-800">
                  <img
                    src={`data:image/jpeg;base64,${result.frame_b64}`}
                    alt="Detected frame"
                    className="w-full block"
                  />
                  <svg
                    className="absolute inset-0 w-full h-full"
                    viewBox={`0 0 ${result.frame_width} ${result.frame_height}`}
                  >
                    {result.tags.map((tag) => {
                      const sel = selectedIndices.has(tag.index);
                      const pts = tag.corners.map(([x, y]) => `${x},${y}`).join(" ");
                      return (
                        <g key={tag.index} onClick={() => toggleTag(tag.index)} style={{ cursor: "pointer" }}>
                          <polygon
                            points={pts}
                            fill={sel ? "rgba(0,220,70,0.15)" : "rgba(255,60,60,0.2)"}
                            stroke={sel ? "#00dc46" : "#ff4444"}
                            strokeWidth={5}
                          />
                          <circle cx={tag.center[0]} cy={tag.center[1]} r={18} fill={sel ? "#00dc46" : "#ff4444"} />
                          <text
                            x={tag.center[0]}
                            y={tag.center[1]}
                            textAnchor="middle"
                            dominantBaseline="middle"
                            fill="black"
                            fontSize={20}
                            fontWeight="bold"
                          >
                            {tag.tag_id}
                          </text>
                        </g>
                      );
                    })}
                  </svg>
                </div>
              </div>

              {/* Warp preview */}
              {(warpB64 || recomputing) && (
                <div>
                  <div className="flex items-center gap-2 mb-1.5">
                    <p className="text-xs text-zinc-500">Warped paper preview</p>
                    {recomputing && <Loader2 className="w-3 h-3 animate-spin text-zinc-500" />}
                  </div>
                  <div className={`rounded-lg overflow-hidden border border-zinc-700 transition-opacity ${recomputing ? "opacity-50" : ""}`}>
                    {warpB64 && (
                      <img src={`data:image/jpeg;base64,${warpB64}`} alt="Warped paper" className="w-full" />
                    )}
                  </div>
                </div>
              )}

              {warpOk && (
                <button
                  onClick={() => onConfirmed({
                    ...result,
                    warped_image_b64: warpB64,
                    success: warpOk,
                    tag_count: selCount,
                  })}
                  disabled={recomputing}
                  className="flex items-center justify-center gap-2 px-4 py-2.5
                             bg-emerald-700 hover:bg-emerald-600 disabled:opacity-50
                             text-white text-sm rounded-lg transition-colors cursor-pointer font-medium"
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
  );
}

// ─── AoI drawing canvas ───────────────────────────────────────────────────────

function DrawCanvas({
  recording,
  warpedImage,
  refTimestamp,
  tagCount,
  areas,
  onAreasChange,
  onRedetect,
  onSave,
}: {
  recording: RecordingMeta;
  warpedImage: string | null;
  refTimestamp: number | null;
  tagCount: number | null;
  areas: AoiArea[];
  onAreasChange: (areas: AoiArea[]) => void;
  onRedetect: () => void;
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
  const [confirmClear, setConfirmClear] = useState(false);

  type DragState = { startX: number; startY: number; origX: number; origY: number; origPoints?: [number, number][] };
  const [dragging, setDragging] = useState<DragState | null>(null);
  const [overShape, setOverShape] = useState(false);

  // Freehand polygon state
  const [polygonPoints, setPolygonPoints] = useState<[number, number][]>([]);
  const [freehandActive, setFreehandActive] = useState(false);

  const paperRef = useRef<HTMLDivElement>(null);
  const lastDrawTool = useRef<DrawingTool>("ellipse");

  // Reset selection when recording/segment changes
  useEffect(() => {
    setSelectedId(null);
    setTool("select");
  }, [recording.id]);

  const addArea = useCallback(() => {
    const id = crypto.randomUUID();
    const newArea: AoiArea = {
      id,
      name: `Area ${areas.length + 1}`,
      color: PALETTE[areas.length % PALETTE.length],
      visible: true,
      shape: null,
    };
    onAreasChange([...areas, newArea]);
    setSelectedId(id);
    setTool(lastDrawTool.current);
  }, [areas, onAreasChange]);

  const cancelPolygon = useCallback(() => {
    setPolygonPoints([]);
    setFreehandActive(false);
    setTool("select");
  }, []);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement).tagName === "INPUT") return;
      if (e.key === "a" || e.key === "A") addArea();
      if (e.key === "Escape" && tool === "polygon") cancelPolygon();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [addArea, tool, cancelPolygon]);

  // Window-level mouse events during freehand drawing so we don't lose the cursor
  useEffect(() => {
    if (!freehandActive) return;

    const onMove = (e: MouseEvent) => {
      if (!paperRef.current) return;
      const r = paperRef.current.getBoundingClientRect();
      const cx = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
      const cy = Math.max(0, Math.min(1, (e.clientY - r.top) / r.height));
      setPolygonPoints((prev) => {
        if (prev.length === 0) return [[cx, cy]];
        const [lx, ly] = prev[prev.length - 1];
        const minDist = 4 / r.width;
        if (Math.hypot(cx - lx, cy - ly) < minDist) return prev;
        return [...prev, [cx, cy]];
      });
    };

    const onUp = () => {
      setFreehandActive(false);
      setPolygonPoints((pts) => {
        if (pts.length >= 3 && selectedId) {
          const xs = pts.map(([x]) => x);
          const ys = pts.map(([, y]) => y);
          const bx = Math.min(...xs), bw = Math.max(...xs) - bx;
          const by = Math.min(...ys), bh = Math.max(...ys) - by;
          const shape: AoiShape = { kind: "polygon", x: bx, y: by, w: bw, h: bh, points: [...pts] };
          onAreasChange(areas.map((a) => (a.id === selectedId ? { ...a, shape } : a)));
        }
        return [];
      });
      setTool("select");
    };

    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, [freehandActive, selectedId, areas, onAreasChange]);

  const toggleVisible = (id: string) =>
    onAreasChange(areas.map((a) => (a.id === id ? { ...a, visible: !a.visible } : a)));

  const deleteArea = async (id: string) => {
    const area = areas.find((a) => a.id === id);
    const ok = await confirmDialog({
      title: "Delete area",
      message: `Delete area "${area?.name ?? "this area"}"?`,
    });
    if (!ok) return;
    onAreasChange(areas.filter((a) => a.id !== id));
    if (selectedId === id) setSelectedId(null);
  };

  const startRename = (area: AoiArea) => { setEditingId(area.id); setEditName(area.name); };

  const commitRename = () => {
    if (editingId) {
      const t = editName.trim();
      if (t) onAreasChange(areas.map((a) => (a.id === editingId ? { ...a, name: t } : a)));
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

  // Raw (unclamped) coords — needed for accurate drag delta
  const getPaperCoordsRaw = (e: React.MouseEvent) => {
    if (!paperRef.current) return null;
    const r = paperRef.current.getBoundingClientRect();
    return { x: (e.clientX - r.left) / r.width, y: (e.clientY - r.top) / r.height };
  };

  const isBoxDrawing = tool === "rectangle" || tool === "ellipse";
  const isDrawing = isBoxDrawing || tool === "polygon";

  const onMouseDown = (e: React.MouseEvent) => {
    if (e.button !== 0) return;
    const pt = getPaperCoords(e);
    if (!pt) return;

    if (tool === "select") {
      const clicked = [...areas].reverse().find((a) => {
        if (!a.visible || !a.shape) return false;
        const { x, y, w, h } = a.shape;
        return pt.x >= x && pt.x <= x + w && pt.y >= y && pt.y <= y + h;
      });
      if (clicked?.shape) {
        setSelectedId(clicked.id);
        setDragging({
          startX: pt.x, startY: pt.y,
          origX: clicked.shape.x, origY: clicked.shape.y,
          origPoints: clicked.shape.points ? clicked.shape.points.map((p) => [p[0], p[1]] as [number, number]) : undefined,
        });
        e.preventDefault();
      } else {
        setSelectedId(null);
      }
      return;
    }

    if (tool === "polygon" && selectedId) {
      setFreehandActive(true);
      setPolygonPoints([[pt.x, pt.y]]);
      e.preventDefault();
      return;
    }

    if (isBoxDrawing) {
      setDrawStart(pt);
      setLiveBox({ kind: tool === "ellipse" ? "ellipse" : "rect", x: pt.x, y: pt.y, w: 0, h: 0 });
      e.preventDefault();
    }
  };

  const onMouseMove = (e: React.MouseEvent) => {
    const raw = getPaperCoordsRaw(e);
    if (!raw) return;

    // Drag-to-move selected shape
    if (tool === "select" && dragging && selectedId) {
      const dx = raw.x - dragging.startX;
      const dy = raw.y - dragging.startY;
      onAreasChange(areas.map((a) => {
        if (a.id !== selectedId || !a.shape) return a;
        if (a.shape.kind === "polygon" && dragging.origPoints) {
          const origPts = dragging.origPoints;
          const origXs = origPts.map(([px]) => px), origYs = origPts.map(([, py]) => py);
          const clampedDx = Math.max(-Math.min(...origXs), Math.min(1 - Math.max(...origXs), dx));
          const clampedDy = Math.max(-Math.min(...origYs), Math.min(1 - Math.max(...origYs), dy));
          const newPts = origPts.map(([px, py]) => [px + clampedDx, py + clampedDy] as [number, number]);
          const xs = newPts.map(([px]) => px), ys = newPts.map(([, py]) => py);
          return { ...a, shape: { ...a.shape, points: newPts, x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) } };
        }
        const { w, h } = a.shape;
        return {
          ...a,
          shape: {
            ...a.shape,
            x: Math.max(0, Math.min(1 - w, dragging.origX + dx)),
            y: Math.max(0, Math.min(1 - h, dragging.origY + dy)),
          },
        };
      }));
      return;
    }

    // Hover detection for cursor in select mode
    if (tool === "select") {
      const cx = Math.max(0, Math.min(1, raw.x));
      const cy = Math.max(0, Math.min(1, raw.y));
      setOverShape(areas.some((a) => {
        if (!a.visible || !a.shape) return false;
        const { x, y, w, h } = a.shape;
        return cx >= x && cx <= x + w && cy >= y && cy <= y + h;
      }));
    }

    // Draw live box
    if (!drawStart || !isBoxDrawing) return;
    const cx = Math.max(0, Math.min(1, raw.x));
    const cy = Math.max(0, Math.min(1, raw.y));
    setLiveBox({
      kind: tool === "ellipse" ? "ellipse" : "rect",
      x: Math.min(drawStart.x, cx),
      y: Math.min(drawStart.y, cy),
      w: Math.abs(cx - drawStart.x),
      h: Math.abs(cy - drawStart.y),
    });
  };

  const onMouseUp = () => {
    if (dragging) { setDragging(null); return; }
    if (!drawStart || !liveBox) return;
    if (liveBox.w > 0.01 && liveBox.h > 0.01 && selectedId) {
      onAreasChange(areas.map((a) => (a.id === selectedId ? { ...a, shape: { ...liveBox } } : a)));
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
    <>
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
            onClick={() => addArea()}
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
          <ToolButton active={tool === "rectangle"} onClick={() => { setTool("rectangle"); lastDrawTool.current = "rectangle"; }} title="Draw rectangle">
            <Square className="w-4 h-4" />
          </ToolButton>
          <ToolButton active={tool === "ellipse"} onClick={() => { setTool("ellipse"); lastDrawTool.current = "ellipse"; }} title="Draw ellipse (A)">
            <Circle className="w-4 h-4" />
          </ToolButton>
          <ToolButton active={tool === "polygon"} onClick={() => { setTool("polygon"); lastDrawTool.current = "polygon"; }} title="Draw freehand polygon">
            <Pencil className="w-4 h-4" />
          </ToolButton>

          <div className="w-px h-5 bg-zinc-700 mx-1" />
          <button
            onClick={() => setConfirmClear(true)}
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

            {areas.every((a) => !a.shape) && polygonPoints.length === 0 && (
              <div className="absolute inset-0 flex items-center justify-center pointer-events-none z-10">
                <p className="text-white/30 text-sm select-none text-center px-8 drop-shadow">
                  {tool === "polygon" && selectedId
                    ? "Hold and drag to draw a freehand shape"
                    : (tool === "rectangle" || tool === "ellipse") && selectedId
                    ? "Click and drag to place the area"
                    : "Select an area, pick a shape tool, then draw"}
                </p>
              </div>
            )}

            <div
              ref={paperRef}
              className="absolute inset-0 z-20"
              style={{
                cursor: dragging ? "grabbing"
                  : isBoxDrawing ? "crosshair"
                  : tool === "polygon" ? "crosshair"
                  : (tool === "select" && overShape) ? "grab"
                  : "default"
              }}
              onMouseDown={onMouseDown}
              onMouseMove={onMouseMove}
              onMouseUp={onMouseUp}
              onContextMenu={(e) => { if (tool === "polygon") { e.preventDefault(); cancelPolygon(); } }}
              onMouseLeave={() => { setDrawStart(null); setLiveBox(null); setDragging(null); setOverShape(false); }}
            />

            <svg className="absolute inset-0 w-full h-full z-20" viewBox="0 0 794 1123" style={{ pointerEvents: "none" }}>
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

              {/* Freehand polygon in-progress preview */}
              {freehandActive && polygonPoints.length > 1 && selectedArea && (
                <polyline
                  points={polygonPoints.map(([x, y]) => `${x * 794},${y * 1123}`).join(" ")}
                  fill="none"
                  stroke={selectedArea.color}
                  strokeWidth={2}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              )}
            </svg>
          </div>
        </div>
      </div>
    </div>
    {confirmClear && (
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
        <div className="bg-zinc-900 border border-zinc-700 rounded-xl shadow-2xl px-6 py-5 flex flex-col gap-4 min-w-[240px]">
          <p className="text-sm text-zinc-200">Delete all areas?</p>
          <div className="flex gap-2 justify-end">
            <button
              onClick={() => setConfirmClear(false)}
              className="px-3 py-1.5 text-xs rounded-md bg-zinc-800 hover:bg-zinc-700 text-zinc-300 cursor-pointer transition-colors"
            >
              Cancel
            </button>
            <button
              onClick={() => { onAreasChange([]); setSelectedId(null); setConfirmClear(false); }}
              className="px-3 py-1.5 text-xs rounded-md bg-red-700 hover:bg-red-600 text-white cursor-pointer transition-colors"
            >
              Delete all
            </button>
          </div>
        </div>
      </div>
    )}
    </>
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
  const fill = { fill: color, fillOpacity: preview ? 0.18 : 0.3 };
  const stroke = { stroke: color, strokeWidth: selected ? 2.5 : 1.5, strokeDasharray: preview ? "5 3" : undefined };

  if (kind === "polygon" && shape.points) {
    const pts = shape.points.map(([px, py]) => `${px * 794},${py * 1123}`).join(" ");
    const n = shape.points.length;
    const lcx = shape.points.reduce((s, [px]) => s + px, 0) / n * 100;
    const lcy = shape.points.reduce((s, [, py]) => s + py, 0) / n * 100;
    return (
      <g>
        <polygon points={pts} {...fill} {...stroke} />
        {selected && !preview && (
          <polygon points={pts} fill="none" stroke="white" strokeWidth={0.8} strokeDasharray="4 3" />
        )}
        {!preview && label && (
          <text x={`${lcx}%`} y={`${lcy}%`} textAnchor="middle" dominantBaseline="middle"
            fill={color} fontSize={13} fontWeight="700" style={{ userSelect: "none" }}>
            {label}
          </text>
        )}
      </g>
    );
  }

  const cx = (x + w / 2) * 100;
  const cy = (y + h / 2) * 100;

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
