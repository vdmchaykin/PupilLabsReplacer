import { useState, useRef, useEffect } from "react";
import { Plus, Eye, EyeOff, Trash2, MousePointer2, Square, Circle, Pencil, Eraser, Minus, Scan } from "lucide-react";

interface AoiShape {
  kind: "rect" | "ellipse";
  x: number; // normalized 0-1, top-left of bounding box
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

const PALETTE = [
  "#f87171", "#fb923c", "#fbbf24", "#4ade80",
  "#34d399", "#22d3ee", "#60a5fa", "#a78bfa",
  "#f472b6", "#94a3b8", "#e879f9", "#facc15",
  "#f43f5e", "#10b981", "#3b82f6", "#8b5cf6",
  "#ec4899", "#06b6d4", "#84cc16", "#d97706",
  "#64748b", "#ef4444", "#0ea5e9", "#14b8a6",
];

export function AoiPage() {
  const [areas, setAreas] = useState<AoiArea[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [tool, setTool] = useState<DrawingTool>("select");
  const [drawStart, setDrawStart] = useState<{ x: number; y: number } | null>(null);
  const [liveBox, setLiveBox] = useState<AoiShape | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState("");

  const paperRef = useRef<HTMLDivElement>(null);

  const addArea = (defaultTool: DrawingTool = "rectangle") => {
    const id = crypto.randomUUID();
    const area: AoiArea = {
      id,
      name: `Area ${areas.length + 1}`,
      color: PALETTE[areas.length % PALETTE.length],
      visible: true,
      shape: null,
    };
    setAreas((prev) => [...prev, area]);
    setSelectedId(id);
    setTool(defaultTool);
  };

  const toggleVisible = (id: string) => {
    setAreas((prev) => prev.map((a) => (a.id === id ? { ...a, visible: !a.visible } : a)));
  };

  const deleteArea = (id: string) => {
    setAreas((prev) => prev.filter((a) => a.id !== id));
    if (selectedId === id) setSelectedId(null);
  };

  const startRename = (area: AoiArea) => {
    setEditingId(area.id);
    setEditName(area.name);
  };

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement).tagName;
      if (tag === "INPUT" || tag === "TEXTAREA") return;
      if (e.key === "a" || e.key === "A") addArea("ellipse");
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [areas.length]);

  const commitRename = () => {
    if (editingId) {
      const trimmed = editName.trim();
      if (trimmed) {
        setAreas((prev) => prev.map((a) => (a.id === editingId ? { ...a, name: trimmed } : a)));
      }
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
      setAreas((prev) =>
        prev.map((a) => (a.id === selectedId ? { ...a, shape: { ...liveBox } } : a))
      );
    }
    setDrawStart(null);
    setLiveBox(null);
    setTool("select");
  };

  const onMouseLeave = () => {
    setDrawStart(null);
    setLiveBox(null);
  };

  const selectedArea = areas.find((a) => a.id === selectedId);
  const drawingCursor = isDrawing ? "crosshair" : "default";

  return (
    <div className="flex h-full overflow-hidden">
      {/* Left panel */}
      <div className="w-52 border-r border-zinc-800 flex flex-col shrink-0 bg-zinc-950">
        <div className="flex items-center justify-between px-3 py-2.5 border-b border-zinc-800">
          <span className="text-sm font-medium text-white">Areas</span>
          <button
            onClick={() => addArea("ellipse")}
            className="flex items-center gap-1 px-2 py-1 bg-indigo-600 hover:bg-indigo-500
                       text-white text-xs rounded-md transition-colors cursor-pointer"
            title="Add area (A)"
          >
            <Plus className="w-3 h-3" />
            Add
          </button>
        </div>

        <div className="flex-1 overflow-auto">
          {areas.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-10 px-4 text-zinc-700">
              <p className="text-xs text-center leading-relaxed">
                Click "+ Add" to define an Area of Interest on the paper
              </p>
            </div>
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
                <div
                  className="w-3 h-3 rounded-sm shrink-0 border border-white/10"
                  style={{ backgroundColor: area.color }}
                />
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
                               rounded border border-zinc-500 focus:border-indigo-500
                               outline-none"
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
      </div>

      {/* Right side: toolbar + canvas */}
      <div className="flex-1 flex flex-col min-w-0 bg-zinc-950">
        {/* Toolbar */}
        <div className="flex items-center gap-1.5 px-4 py-2 border-b border-zinc-800 shrink-0">
          <ToolButton active={tool === "select"} onClick={() => setTool("select")} title="Select">
            <MousePointer2 className="w-4 h-4" />
          </ToolButton>
          <ToolButton
            active={tool === "polygon"}
            onClick={() => {}}
            title="Arbitrary polygon — requires click-by-click vertex placement with a separate state machine; not yet implemented"
            disabled
          >
            <Pencil className="w-4 h-4" />
          </ToolButton>
          <ToolButton active={tool === "rectangle"} onClick={() => setTool("rectangle")} title="Draw rectangle">
            <Square className="w-4 h-4" />
          </ToolButton>
          <ToolButton active={tool === "ellipse"} onClick={() => setTool("ellipse")} title="Draw ellipse / circle (default)">
            <Circle className="w-4 h-4" />
          </ToolButton>
          <ToolButton
            active={tool === "subtract"}
            onClick={() => {}}
            title="Subtract region — coming soon"
            disabled
          >
            <Minus className="w-4 h-4" />
          </ToolButton>
          <ToolButton
            active={tool === "erase"}
            onClick={() => {}}
            title="Erase area — coming soon"
            disabled
          >
            <Eraser className="w-4 h-4" />
          </ToolButton>
          <div className="w-px h-5 bg-zinc-700 mx-1" />
          <button
            onClick={() => { setAreas([]); setSelectedId(null); }}
            disabled={areas.length === 0}
            className="px-3 py-1 text-xs text-zinc-500 hover:text-white
                       disabled:opacity-30 disabled:cursor-not-allowed
                       cursor-pointer transition-colors rounded"
          >
            Clear
          </button>
        </div>

        {/* Paper canvas */}
        <div className="flex-1 flex items-center justify-center overflow-hidden p-10">
          <div className="flex flex-col items-center gap-3 h-full max-h-full">
            <div className="flex items-center gap-1.5 text-xs text-zinc-600">
              <Scan className="w-3.5 h-3.5" />
              <span>Paper position detected via AprilTags in video — coming in Phase 6</span>
            </div>

            {/* A4 paper sheet */}
            <div
              className="relative bg-white shadow-2xl overflow-hidden flex-shrink-0"
              style={{ aspectRatio: "210 / 297", height: "calc(100% - 28px)" }}
            >
              <AprilTagMarker position="top-left" />
              <AprilTagMarker position="top-right" />
              <AprilTagMarker position="bottom-left" />
              <AprilTagMarker position="bottom-right" />

              {areas.every((a) => !a.shape) && (
                <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
                  <p className="text-zinc-300 text-sm select-none text-center px-8">
                    {(tool === "rectangle" || tool === "ellipse") && selectedId
                      ? "Click and drag to place the area"
                      : "Select an area, pick a shape tool, then drag"}
                  </p>
                </div>
              )}

              {/* Drawing surface */}
              <div
                ref={paperRef}
                className="absolute inset-0"
                style={{ cursor: drawingCursor }}
                onMouseDown={onMouseDown}
                onMouseMove={onMouseMove}
                onMouseUp={onMouseUp}
                onMouseLeave={onMouseLeave}
              />

              {/* SVG overlays */}
              <svg className="absolute inset-0 w-full h-full" style={{ pointerEvents: "none" }}>
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

                {/* Live preview while dragging */}
                {liveBox && selectedArea && (
                  <ShapeOverlay
                    shape={liveBox}
                    color={selectedArea.color}
                    label=""
                    selected={false}
                    preview
                  />
                )}
              </svg>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

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

  const sharedFill = { fill: color, fillOpacity: preview ? 0.18 : 0.28 };
  const sharedStroke = {
    stroke: color,
    strokeWidth: selected ? 2.5 : 1.5,
    strokeDasharray: preview ? "5 3" : undefined,
  };

  return (
    <g>
      {kind === "rect" ? (
        <rect
          x={`${x * 100}%`} y={`${y * 100}%`}
          width={`${w * 100}%`} height={`${h * 100}%`}
          rx={3}
          {...sharedFill} {...sharedStroke}
        />
      ) : (
        <ellipse
          cx={`${cx}%`} cy={`${cy}%`}
          rx={`${(w / 2) * 100}%`} ry={`${(h / 2) * 100}%`}
          {...sharedFill} {...sharedStroke}
        />
      )}

      {selected && !preview && kind === "rect" && (
        <rect
          x={`${x * 100}%`} y={`${y * 100}%`}
          width={`${w * 100}%`} height={`${h * 100}%`}
          fill="none" stroke="white" strokeWidth={0.8} strokeDasharray="4 3" rx={3}
        />
      )}
      {selected && !preview && kind === "ellipse" && (
        <ellipse
          cx={`${cx}%`} cy={`${cy}%`}
          rx={`${(w / 2) * 100}%`} ry={`${(h / 2) * 100}%`}
          fill="none" stroke="white" strokeWidth={0.8} strokeDasharray="4 3"
        />
      )}

      {!preview && label && (
        <text
          x={`${cx}%`} y={`${cy}%`}
          textAnchor="middle" dominantBaseline="middle"
          fill={color} fontSize={13} fontWeight="700"
          style={{ userSelect: "none" }}
        >
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

function AprilTagMarker({ position }: {
  position: "top-left" | "top-right" | "bottom-left" | "bottom-right";
}) {
  const posClass = {
    "top-left": "top-2 left-2",
    "top-right": "top-2 right-2",
    "bottom-left": "bottom-2 left-2",
    "bottom-right": "bottom-2 right-2",
  }[position];

  return (
    <div className={`absolute ${posClass} w-9 h-9 opacity-20 pointer-events-none`}>
      <svg viewBox="0 0 9 9" className="w-full h-full" style={{ imageRendering: "pixelated" }}>
        <rect x="0" y="0" width="9" height="9" fill="black" />
        <rect x="1" y="1" width="7" height="7" fill="white" />
        <rect x="2" y="2" width="5" height="5" fill="black" />
        <rect x="3" y="3" width="3" height="3" fill="white" />
        <rect x="4" y="4" width="1" height="1" fill="black" />
      </svg>
    </div>
  );
}
