import { useState } from "react";
import type { RecordingEvent } from "@/types";

export const EVENT_COLOR_A = "#f59e0b";
export const EVENT_COLOR_B = "#38bdf8";
export const EVENT_COLOR_CUSTOM = "#4ade80";

export function formatTs(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  const ms = Math.round((sec % 1) * 10);
  return `${m}:${s.toString().padStart(2, "0")}.${ms}`;
}

type Section = { start: number; end: number; type: "a" | "b" };
type EventSpan = { start: number; end: number; label: string; startIndex: number; section: "a" | "b" | "custom" };
type EventTick = { index: number; timestamp_s: number; name: string; section: "a" | "b" | "custom" };

export function buildEventSpans(events: RecordingEvent[]): { spans: EventSpan[]; ticks: EventTick[] } {
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

interface EventSeekbarProps {
  events: RecordingEvent[];
  duration: number;
  currentTime: number;
  onSeek: (t: number) => void;
  colorA?: string;
  colorB?: string;
  colorCustom?: string;
  disabled?: boolean;
}

export function EventSeekbar({
  events,
  duration,
  currentTime,
  onSeek,
  colorA = EVENT_COLOR_A,
  colorB = EVENT_COLOR_B,
  colorCustom = EVENT_COLOR_CUSTOM,
  disabled = false,
}: EventSeekbarProps) {
  type HoveredItem = { label: string; start: number; end: number | null; pct: number };
  const [hoveredItem, setHoveredItem] = useState<HoveredItem | null>(null);
  const { spans, ticks } = buildEventSpans(events);

  const handleMouseMove = (e: React.MouseEvent<HTMLDivElement>) => {
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

  const progress = duration > 0 ? (currentTime / duration) * 100 : 0;

  return (
    <div
      className={`relative h-1.5 group ${disabled ? "opacity-30" : ""}`}
      onMouseMove={handleMouseMove}
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
        onChange={(e) => onSeek(parseFloat(e.target.value))}
        disabled={disabled}
        className="absolute inset-0 w-full opacity-0 cursor-pointer h-full disabled:cursor-not-allowed"
      />
    </div>
  );
}
