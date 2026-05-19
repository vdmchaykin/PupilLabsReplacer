import { useEffect, useRef, useState, useCallback } from "react";
import {
  CalendarClock, ChevronRight, ChevronDown, Play, Pause, Volume2, VolumeX,
  Pencil, Trash2, Check, X, ScanEye,
} from "lucide-react";
import { api } from "@/lib/api";
import { formatDuration, formatDate } from "@/lib/utils";
import type { RecordingMeta, RecordingEvent } from "@/types";

const API = "http://localhost:8765";

// ─── TMT sequence generators ──────────────────────────────────────────────────

function tmtASequence(): string[] {
  const seq: string[] = ["test01_begin"];
  for (let i = 1; i <= 25; i++) {
    seq.push(String(i));
    seq.push(`${i}_out`);
  }
  seq.push("test01_end");
  return seq;
}

const LETTERS = ["A", "B", "C", "D", "E", "F", "G", "H", "I", "J", "K", "L"];

function tmtBSequence(): string[] {
  const seq: string[] = ["test02_begin"];
  // Standard TMT-B: 1 → A → 2 → B → ... → 12 → L → 13
  for (let i = 1; i <= 13; i++) {
    seq.push(`02_${i}`);
    seq.push(`02_${i}_out`);
    if (i - 1 < LETTERS.length) {
      seq.push(`02_${LETTERS[i - 1]}`);
      seq.push(`02_${LETTERS[i - 1]}_out`);
    }
  }
  seq.push("test02_end");
  return seq;
}

const TMT_A = tmtASequence();
const TMT_B = tmtBSequence();

const MARKER_COLORS = [
  { label: "Amber",  value: "#f59e0b" },
  { label: "Sky",    value: "#38bdf8" },
  { label: "Green",  value: "#4ade80" },
  { label: "Rose",   value: "#fb7185" },
  { label: "Purple", value: "#a78bfa" },
];

function nextTMTLabel(events: RecordingEvent[], seq: string[]): string {
  for (let i = seq.length - 1; i >= 0; i--) {
    if (events.some((e) => e.name === seq[i])) {
      return seq[Math.min(i + 1, seq.length - 1)];
    }
  }
  return seq[0];
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function formatTs(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  const ms = Math.round((sec % 1) * 10);
  return `${m}:${s.toString().padStart(2, "0")}.${ms}`;
}

function formatTime(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

type Section = { start: number; end: number; type: "a" | "b" };
type EventSpan = { start: number; end: number; label: string; startIndex: number; section: "a" | "b" | "custom" };
type EventTick = { index: number; timestamp_s: number; name: string; section: "a" | "b" | "custom" };

function buildEventSpans(events: RecordingEvent[]): { spans: EventSpan[]; ticks: EventTick[] } {
  const sorted = [...events].sort((a, b) => a.timestamp_s - b.timestamp_s);

  // Derive section ranges from begin/end markers
  const sections: Section[] = [];
  let cur: { start: number; type: "a" | "b" } | null = null;
  for (const ev of sorted) {
    if (ev.name === "test01_begin") cur = { start: ev.timestamp_s, type: "a" };
    else if (ev.name === "test02_begin") cur = { start: ev.timestamp_s, type: "b" };
    else if ((ev.name === "test01_end" || ev.name === "test02_end") && cur) {
      sections.push({ ...cur, end: ev.timestamp_s });
      cur = null;
    }
  }
  if (cur) sections.push({ ...cur, end: Infinity });

  const sectionOf = (t: number): "a" | "b" | "custom" =>
    sections.find((s) => t >= s.start && t <= s.end)?.type ?? "custom";

  const spans: EventSpan[] = [];
  const ticks: EventTick[] = [];

  for (let i = 0; i < sorted.length; i++) {
    const ev = sorted[i];
    if (ev.name.endsWith("_out")) continue;

    const section = sectionOf(ev.timestamp_s);
    const sectionEnd = sections.find((s) => ev.timestamp_s >= s.start && ev.timestamp_s <= s.end)?.end ?? Infinity;
    const outName = ev.name + "_out";

    let endTs: number | undefined;
    for (let j = i + 1; j < sorted.length; j++) {
      if (sorted[j].timestamp_s > sectionEnd) break;
      if (sorted[j].name === outName) { endTs = sorted[j].timestamp_s; break; }
    }

    if (endTs !== undefined)
      spans.push({ start: ev.timestamp_s, end: endTs, label: ev.name, startIndex: ev.index, section });
    else
      ticks.push({ index: ev.index, timestamp_s: ev.timestamp_s, name: ev.name, section });
  }

  return { spans, ticks };
}

// ─── Recording selector ───────────────────────────────────────────────────────

function RecordingSelector({
  recordings,
  loading,
  onSelect,
}: {
  recordings: RecordingMeta[];
  loading: boolean;
  onSelect: (rec: RecordingMeta) => void;
}) {
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
        <p className="text-sm">Select a recording to start event marking</p>
      </div>
    </div>
  );
}

// ─── Inline video player ──────────────────────────────────────────────────────

interface InlinePlayerProps {
  recordingId: string;
  events: RecordingEvent[];
  duration: number;
  onDurationLoaded: (d: number) => void;
  onTimeUpdate: (t: number) => void;
  playerRef: React.RefObject<HTMLVideoElement | null>;
  colorA: string;
  colorB: string;
  colorCustom: string;
}

function InlinePlayer({
  recordingId,
  events,
  duration,
  onDurationLoaded,
  onTimeUpdate,
  playerRef,
  colorA,
  colorB,
  colorCustom,
}: InlinePlayerProps) {
  const [playing, setPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [muted, setMuted] = useState(true);
  const [speed, setSpeed] = useState(1);
  type HoveredItem = { label: string; start: number; end: number | null; pct: number };
  const [hoveredItem, setHoveredItem] = useState<HoveredItem | null>(null);
  const { spans, ticks } = buildEventSpans(events);

  const handleSeekbarMouseMove = (e: React.MouseEvent<HTMLDivElement>) => {
    if (duration === 0) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const t = ((e.clientX - rect.left) / rect.width) * duration;

    const sp = spans.find((s) => t >= s.start && t <= s.end);
    if (sp) {
      const centerPct = ((sp.start + (sp.end - sp.start) / 2) / duration) * 100;
      setHoveredItem({ label: sp.label, start: sp.start, end: sp.end, pct: Math.max(5, Math.min(95, centerPct)) });
      return;
    }

    const toleranceSec = (6 / rect.width) * duration;
    const tk = ticks.find((t2) => Math.abs(t2.timestamp_s - t) <= toleranceSec);
    if (tk) {
      const pct = (tk.timestamp_s / duration) * 100;
      setHoveredItem({ label: tk.name, start: tk.timestamp_s, end: null, pct: Math.max(5, Math.min(95, pct)) });
      return;
    }

    setHoveredItem(null);
  };

  const toggle = () => {
    const v = playerRef.current;
    if (!v) return;
    if (v.paused) v.play();
    else v.pause();
  };

  const handleSeek = (e: React.ChangeEvent<HTMLInputElement>) => {
    const t = parseFloat(e.target.value);
    if (playerRef.current) playerRef.current.currentTime = t;
    setCurrentTime(t);
  };

  useEffect(() => {
    const v = playerRef.current;
    if (!v) return;
    const onTime = () => { setCurrentTime(v.currentTime); onTimeUpdate(v.currentTime); };
    const onMeta = () => onDurationLoaded(v.duration);
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
  }, [onDurationLoaded, onTimeUpdate, playerRef]);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement).tagName;
      if (tag === "INPUT" || tag === "TEXTAREA") return;
      const v = playerRef.current;
      if (!v) return;
      if (e.code === "Space") { e.preventDefault(); if (v.paused) v.play(); else v.pause(); }
      else if (e.code === "ArrowRight") { e.preventDefault(); v.currentTime = Math.min(v.currentTime + 1, v.duration); }
      else if (e.code === "ArrowLeft") { e.preventDefault(); v.currentTime = Math.max(v.currentTime - 1, 0); }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [playerRef]);

  const progress = duration > 0 ? (currentTime / duration) * 100 : 0;

  return (
    <div className="flex flex-col h-full bg-black">
      {/* Video */}
      <div
        className="relative flex-1 overflow-hidden cursor-pointer"
        onClick={toggle}
      >
        <video
          ref={playerRef as React.RefObject<HTMLVideoElement>}
          src={`${API}/api/recordings/${recordingId}/video/scene`}
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

        {/* Event markers on seekbar overlay (drawn at bottom of video area) */}
      </div>

      {/* Controls */}
      <div className="flex flex-col gap-2 px-3 py-2.5 bg-zinc-900 border-t border-zinc-800">
        {/* Seekbar */}
        <div
          className="relative h-1.5 group"
          onMouseMove={handleSeekbarMouseMove}
          onMouseLeave={() => setHoveredItem(null)}
        >
          {hoveredItem && (
            <div
              className="absolute bottom-full mb-2 -translate-x-1/2 bg-zinc-800 border border-zinc-700
                         rounded px-2 py-1 text-xs text-white whitespace-nowrap pointer-events-none z-10 shadow-lg"
              style={{ left: `${hoveredItem.pct}%` }}
            >
              <span className="font-medium">{hoveredItem.label}</span>
              {hoveredItem.end !== null ? (
                <>
                  <span className="text-zinc-400 ml-2">{formatTs(hoveredItem.start)} → {formatTs(hoveredItem.end)}</span>
                  <span className="text-zinc-500 ml-1">({formatTs(hoveredItem.end - hoveredItem.start)})</span>
                </>
              ) : (
                <span className="text-zinc-400 ml-2">{formatTs(hoveredItem.start)}</span>
              )}
            </div>
          )}
          <div className="absolute inset-0 bg-zinc-700 rounded-full" />
          <div
            className="absolute inset-y-0 left-0 bg-indigo-500 rounded-full pointer-events-none"
            style={{ width: `${progress}%` }}
          />
          {/* Event markers */}
          {duration > 0 && spans.map((sp) => {
            const color = sp.section === "a" ? colorA : sp.section === "b" ? colorB : colorCustom;
            return (
              <div
                key={sp.startIndex}
                className="absolute top-0 h-full pointer-events-none"
                style={{ left: `${(sp.start / duration) * 100}%`, width: `${Math.max(((sp.end - sp.start) / duration) * 100, 0.3)}%`, backgroundColor: color + "99" }}
              />
            );
          })}
          {duration > 0 && ticks.map((ev) => {
            const color = ev.section === "a" ? colorA : ev.section === "b" ? colorB : colorCustom;
            return (
              <div
                key={ev.index}
                className="absolute top-0 w-0.5 h-full rounded-full pointer-events-none"
                style={{ left: `${(ev.timestamp_s / duration) * 100}%`, backgroundColor: color }}
              />
            );
          })}
          <input
            type="range"
            min={0}
            max={duration || 0}
            step={0.05}
            value={currentTime}
            onChange={handleSeek}
            className="absolute inset-0 w-full opacity-0 cursor-pointer h-full"
          />
        </div>

        {/* Buttons */}
        <div className="flex items-center gap-2">
          <button onClick={toggle} className="text-white hover:text-indigo-400 transition-colors cursor-pointer">
            {playing ? <Pause className="w-4 h-4" /> : <Play className="w-4 h-4" />}
          </button>
          <button
            onClick={() => { const next = !muted; setMuted(next); if (playerRef.current) playerRef.current.muted = next; }}
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
              onClick={() => {
                setSpeed(s);
                if (playerRef.current) playerRef.current.playbackRate = s;
              }}
              className={`text-xs px-1.5 py-0.5 rounded transition-colors cursor-pointer
                ${speed === s ? "bg-indigo-600 text-white" : "text-zinc-400 hover:text-white"}`}
            >
              {s}×
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

// ─── Events panel ─────────────────────────────────────────────────────────────

interface EventsPanelProps {
  recordingId: string;
  events: RecordingEvent[];
  currentTime: number;
  onEventsChange: (events: RecordingEvent[]) => void;
  onSeekTo: (t: number) => void;
  colorA: string;
  colorB: string;
  colorCustom: string;
  onColorAChange: (c: string) => void;
  onColorBChange: (c: string) => void;
  onColorCustomChange: (c: string) => void;
}

function EventsPanel({
  recordingId,
  events,
  currentTime,
  onEventsChange,
  onSeekTo,
  colorA,
  colorB,
  colorCustom,
  onColorAChange,
  onColorBChange,
  onColorCustomChange,
}: EventsPanelProps) {
  const [manualName, setManualName] = useState("");
  const [editingIndex, setEditingIndex] = useState<number | null>(null);
  const [editName, setEditName] = useState("");
  const [colorsOpen, setColorsOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const nextA = nextTMTLabel(events, TMT_A);
  const nextB = nextTMTLabel(events, TMT_B);

  const addEvent = useCallback(
    async (timestamp_s: number, name: string) => {
      if (!name.trim()) return;
      const updated = await api.post<RecordingEvent[]>(
        `/api/recordings/${recordingId}/events`,
        { timestamp_s, name: name.trim() }
      );
      onEventsChange(updated);
    },
    [recordingId, onEventsChange]
  );

  const handleManualAdd = async () => {
    await addEvent(currentTime, manualName);
    setManualName("");
  };

  const handleTMTA = () => addEvent(currentTime, nextA);
  const handleTMTB = () => addEvent(currentTime, nextB);

  const handleDelete = async (index: number) => {
    const updated = await api.delete<RecordingEvent[]>(
      `/api/recordings/${recordingId}/events/${index}`
    );
    onEventsChange(updated);
  };

  const startEdit = (ev: RecordingEvent) => {
    setEditingIndex(ev.index);
    setEditName(ev.name);
  };

  const commitEdit = async (index: number) => {
    if (!editName.trim()) { setEditingIndex(null); return; }
    const updated = await api.put<RecordingEvent[]>(
      `/api/recordings/${recordingId}/events/${index}`,
      { name: editName.trim() }
    );
    onEventsChange(updated);
    setEditingIndex(null);
  };

  // E / R key shortcuts: add next TMT-A or TMT-B (skip if input focused)
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.code !== "KeyE" && e.code !== "KeyR") return;
      const tag = (e.target as HTMLElement).tagName;
      if (tag === "INPUT" || tag === "TEXTAREA") return;
      e.preventDefault();
      if (e.code === "KeyE") addEvent(currentTime, e.shiftKey ? "test01_end" : nextA);
      else addEvent(currentTime, e.shiftKey ? "test02_end" : nextB);
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [currentTime, nextA, nextB, addEvent]);

  return (
    <div className="flex flex-col h-full border-l border-zinc-800 bg-zinc-950">
      {/* Header */}
      <div className="px-6 py-3 border-b border-zinc-800 shrink-0 flex items-center justify-between">
        <p className="text-sm font-medium text-white">Events</p>
        <span className="text-xs tabular-nums bg-zinc-800 text-zinc-500 px-2 py-0.5 rounded-full">
          {events.length}
        </span>
      </div>

      {/* Manual add */}
      <div className="px-3 py-3 border-b border-zinc-800 shrink-0 space-y-2">
        <div className="flex gap-2">
          <input
            ref={inputRef}
            value={manualName}
            onChange={(e) => setManualName(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") handleManualAdd(); }}
            placeholder="Event name…"
            className="flex-1 px-2.5 py-1.5 bg-zinc-900 border border-zinc-700
                       rounded text-sm text-white placeholder-zinc-600
                       focus:outline-none focus:border-indigo-500"
          />
          <button
            onClick={handleManualAdd}
            disabled={!manualName.trim()}
            className="px-3 py-1.5 bg-indigo-600 hover:bg-indigo-500
                       disabled:opacity-30 disabled:cursor-not-allowed
                       text-white text-sm rounded transition-colors cursor-pointer"
          >
            Add
          </button>
        </div>

        {/* TMT quick templates */}
        <div className="space-y-1.5">
          <p className="text-[10px] text-zinc-600 uppercase tracking-wider">Quick templates</p>
          <div className="flex gap-2">
            <button
              onClick={handleTMTA}
              title="Add next TMT-A event (also E key)"
              className="flex-1 flex items-center gap-1.5 px-2.5 py-1.5
                         bg-zinc-800 hover:bg-amber-950 border border-zinc-700
                         hover:border-amber-700 rounded text-xs transition-colors cursor-pointer group"
            >
              <span className="text-zinc-400 group-hover:text-amber-400 font-medium">TMT-A</span>
              <span className="text-zinc-500 group-hover:text-amber-300 truncate">{nextA}</span>
              <kbd className="ml-auto text-[9px] text-zinc-600 bg-zinc-900 px-1 py-0.5 rounded">E</kbd>
            </button>
            <button
              onClick={() => addEvent(currentTime, "test01_end")}
              title="Add test01_end (also Shift+E)"
              className="flex items-center gap-1.5 px-2.5 py-1.5 bg-zinc-800 hover:bg-amber-950
                         border border-zinc-700 hover:border-amber-700 rounded text-xs
                         transition-colors cursor-pointer group"
            >
              <span className="font-mono text-zinc-500 group-hover:text-amber-300">test01_end</span>
              <kbd className="text-[9px] text-zinc-600 bg-zinc-900 px-1 py-0.5 rounded">⇧E</kbd>
            </button>
          </div>
          <div className="flex gap-2">
            <button
              onClick={handleTMTB}
              className="flex-1 flex items-center gap-1.5 px-2.5 py-1.5
                         bg-zinc-800 hover:bg-sky-950 border border-zinc-700
                         hover:border-sky-700 rounded text-xs transition-colors cursor-pointer group"
            >
              <span className="text-zinc-400 group-hover:text-sky-400 font-medium">TMT-B</span>
              <span className="text-zinc-500 group-hover:text-sky-300 truncate">{nextB}</span>
              <kbd className="ml-auto text-[9px] text-zinc-600 bg-zinc-900 px-1 py-0.5 rounded">R</kbd>
            </button>
            <button
              onClick={() => addEvent(currentTime, "test02_end")}
              title="Add test02_end (also Shift+R)"
              className="flex items-center gap-1.5 px-2.5 py-1.5 bg-zinc-800 hover:bg-sky-950
                         border border-zinc-700 hover:border-sky-700 rounded text-xs
                         transition-colors cursor-pointer group"
            >
              <span className="font-mono text-zinc-500 group-hover:text-sky-300">test02_end</span>
              <kbd className="text-[9px] text-zinc-600 bg-zinc-900 px-1 py-0.5 rounded">⇧R</kbd>
            </button>
          </div>
        </div>

        {/* Marker colors */}
        <div className="space-y-1.5">
          <button
            onClick={() => setColorsOpen((o) => !o)}
            className="flex items-center gap-1 cursor-pointer group"
          >
            <p className="text-[10px] text-zinc-600 group-hover:text-zinc-400 uppercase tracking-wider">Marker colors</p>
            <ChevronDown className={`w-3 h-3 text-zinc-600 group-hover:text-zinc-400 transition-transform ${colorsOpen ? "" : "-rotate-90"}`} />
          </button>
          {colorsOpen && ([["TMT-A", colorA, onColorAChange], ["TMT-B", colorB, onColorBChange], ["Custom", colorCustom, onColorCustomChange]] as const).map(([label, active, onChange]) => (
            <div key={label} className="flex items-center gap-2">
              <span className="text-xs text-zinc-500 w-10">{label}</span>
              {MARKER_COLORS.map((c) => (
                <button
                  key={c.value}
                  title={c.label}
                  onClick={() => onChange(c.value)}
                  className="w-4 h-4 rounded-full transition-transform hover:scale-110 cursor-pointer shrink-0"
                  style={{
                    backgroundColor: c.value,
                    outline: active === c.value ? `2px solid ${c.value}` : "2px solid transparent",
                    outlineOffset: "2px",
                  }}
                />
              ))}
            </div>
          ))}
        </div>
      </div>

      {/* Events list */}
      <div className="flex-1 overflow-auto">
        {events.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-12 text-zinc-600">
            <ScanEye className="w-7 h-7 mb-2 opacity-30" />
            <p className="text-xs">No events yet</p>
          </div>
        ) : (
          <div className="divide-y divide-zinc-800/50">
            {events.map((ev) => (
              <div
                key={ev.index}
                className="flex items-center gap-2 px-3 py-2 hover:bg-zinc-900 group"
              >
                {/* Timestamp — click to seek */}
                <button
                  onClick={() => onSeekTo(ev.timestamp_s)}
                  className="text-xs text-indigo-400 hover:text-indigo-300 tabular-nums
                             font-mono shrink-0 cursor-pointer w-14 text-left"
                  title="Seek to event"
                >
                  {formatTs(ev.timestamp_s)}
                </button>

                {/* Name / edit */}
                {editingIndex === ev.index ? (
                  <div className="flex flex-1 items-center gap-1 min-w-0">
                    <input
                      autoFocus
                      value={editName}
                      onChange={(e) => setEditName(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") commitEdit(ev.index);
                        if (e.key === "Escape") setEditingIndex(null);
                      }}
                      className="flex-1 px-1.5 py-0.5 bg-zinc-800 border border-zinc-600
                                 rounded text-xs text-white focus:outline-none focus:border-indigo-500 min-w-0"
                    />
                    <button onClick={() => commitEdit(ev.index)}
                      className="text-emerald-400 hover:text-emerald-300 cursor-pointer shrink-0">
                      <Check className="w-3.5 h-3.5" />
                    </button>
                    <button onClick={() => setEditingIndex(null)}
                      className="text-zinc-500 hover:text-zinc-300 cursor-pointer shrink-0">
                      <X className="w-3.5 h-3.5" />
                    </button>
                  </div>
                ) : (
                  <>
                    <span className="flex-1 text-xs text-white truncate">{ev.name}</span>
                    <button
                      onClick={() => startEdit(ev)}
                      className="opacity-0 group-hover:opacity-100 text-zinc-500
                                 hover:text-zinc-300 transition-all cursor-pointer shrink-0"
                    >
                      <Pencil className="w-3 h-3" />
                    </button>
                    <button
                      onClick={() => handleDelete(ev.index)}
                      className="opacity-0 group-hover:opacity-100 text-zinc-500
                                 hover:text-red-400 transition-all cursor-pointer shrink-0"
                    >
                      <Trash2 className="w-3 h-3" />
                    </button>
                  </>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Main page ────────────────────────────────────────────────────────────────

export function EventsPage() {
  const [recordings, setRecordings] = useState<RecordingMeta[]>([]);
  const [loadingRecs, setLoadingRecs] = useState(true);
  const [selected, setSelected] = useState<RecordingMeta | null>(null);
  const [events, setEvents] = useState<RecordingEvent[]>([]);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [colorA, setColorA] = useState("#f59e0b");
  const [colorB, setColorB] = useState("#38bdf8");
  const [colorCustom, setColorCustom] = useState("#4ade80");

  const videoRef = useRef<HTMLVideoElement | null>(null);

  useEffect(() => {
    api.get<RecordingMeta[]>("/api/recordings")
      .then(setRecordings)
      .finally(() => setLoadingRecs(false));
  }, []);

  const handleSelect = async (rec: RecordingMeta) => {
    setSelected(rec);
    setEvents([]);
    setCurrentTime(0);
    setDuration(0);
    try {
      const evs = await api.get<RecordingEvent[]>(`/api/recordings/${rec.id}/events`);
      setEvents(evs);
    } catch { /* no events.csv yet */ }
  };

  const handleSeekTo = (t: number) => {
    if (videoRef.current) {
      videoRef.current.currentTime = t;
      setCurrentTime(t);
    }
  };

  if (!selected) {
    return (
      <RecordingSelector
        recordings={recordings}
        loading={loadingRecs}
        onSelect={handleSelect}
      />
    );
  }

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center gap-3 px-4 h-11 border-b border-zinc-800 shrink-0">
        <button
          onClick={() => setSelected(null)}
          className="text-xs text-zinc-400 hover:text-white transition-colors cursor-pointer"
        >
          ← All Recordings
        </button>
        <span className="text-zinc-700">|</span>
        <span className="text-sm font-medium text-white">{selected.name}</span>
        {selected.wearer_name && (
          <span className="text-xs text-zinc-500">{selected.wearer_name}</span>
        )}
      </div>

      {/* Body: events panel (left) + video (right) */}
      <div className="flex flex-1 min-h-0">
        <div className="w-100 shrink-0">
          <EventsPanel
            recordingId={selected.id}
            events={events}
            currentTime={currentTime}
            onEventsChange={setEvents}
            onSeekTo={handleSeekTo}
            colorA={colorA}
            colorB={colorB}
            colorCustom={colorCustom}
            onColorAChange={setColorA}
            onColorBChange={setColorB}
            onColorCustomChange={setColorCustom}
          />
        </div>
        <div className="flex-1 min-w-0">
          <InlinePlayer
            recordingId={selected.id}
            events={events}
            duration={duration}
            onDurationLoaded={setDuration}
            onTimeUpdate={setCurrentTime}
            playerRef={videoRef}
            colorA={colorA}
            colorB={colorB}
            colorCustom={colorCustom}
          />
        </div>
      </div>
    </div>
  );
}
