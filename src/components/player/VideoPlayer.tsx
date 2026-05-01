import { useEffect, useRef, useState, useCallback } from "react";
import {
  Play, Pause, Eye, EyeOff, Volume2, VolumeX, Maximize2,
} from "lucide-react";

const API = "http://localhost:8765";

interface VideoPlayerProps {
  recordingId: string;
  hasEyeVideo: boolean;
}

interface DragPos { x: number; y: number }

function formatTime(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

export function VideoPlayer({ recordingId, hasEyeVideo }: VideoPlayerProps) {
  const sceneRef = useRef<HTMLVideoElement>(null);
  const eyeRef = useRef<HTMLVideoElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const seekRef = useRef<HTMLInputElement>(null);

  const [playing, setPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [muted, setMuted] = useState(true);
  const [speed, setSpeed] = useState(1);
  const [showEye, setShowEye] = useState(true);
  const [eyePos, setEyePos] = useState<DragPos>({ x: 16, y: 16 });
  const [dragging, setDragging] = useState(false);
  const dragOffset = useRef<DragPos>({ x: 0, y: 0 });

  // Sync scene → eye on seek
  const syncEye = useCallback((time: number) => {
    if (eyeRef.current) eyeRef.current.currentTime = time;
  }, []);

  const togglePlay = () => {
    const v = sceneRef.current;
    const e = eyeRef.current;
    if (!v) return;
    if (v.paused) {
      v.play();
      e?.play();
    } else {
      v.pause();
      e?.pause();
    }
  };

  const handleSeek = (e: React.ChangeEvent<HTMLInputElement>) => {
    const t = parseFloat(e.target.value);
    if (sceneRef.current) sceneRef.current.currentTime = t;
    syncEye(t);
    setCurrentTime(t);
  };

  const handleSpeedChange = (s: number) => {
    setSpeed(s);
    if (sceneRef.current) sceneRef.current.playbackRate = s;
    if (eyeRef.current) eyeRef.current.playbackRate = s;
  };

  const handleMute = () => {
    const next = !muted;
    setMuted(next);
    if (sceneRef.current) sceneRef.current.muted = next;
  };

  // Dragging logic for eye PiP
  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    setDragging(true);
    dragOffset.current = {
      x: e.clientX - eyePos.x,
      y: e.clientY - eyePos.y,
    };
  };

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!dragging || !containerRef.current) return;
    const container = containerRef.current.getBoundingClientRect();
    const eyeW = 240;
    const eyeH = 160;
    const x = Math.max(0, Math.min(
      e.clientX - dragOffset.current.x - container.left,
      container.width - eyeW
    ));
    const y = Math.max(0, Math.min(
      e.clientY - dragOffset.current.y - container.top,
      container.height - eyeH
    ));
    setEyePos({ x, y });
  };

  const onPointerUp = () => setDragging(false);

  // When eye video becomes visible again — sync and resume if scene is playing
  useEffect(() => {
    const e = eyeRef.current;
    const v = sceneRef.current;
    if (!e || !v || !showEye) return;
    e.currentTime = v.currentTime;
    e.playbackRate = speed;
    if (!v.paused) e.play();
  }, [showEye]);

  // Video event listeners
  useEffect(() => {
    const v = sceneRef.current;
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

  // Space bar toggle
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.code === "Space" && e.target === document.body) {
        e.preventDefault();
        togglePlay();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  const progress = duration > 0 ? (currentTime / duration) * 100 : 0;

  return (
    <div className="flex flex-col h-full bg-black">
      {/* Video container */}
      <div
        ref={containerRef}
        className="relative flex-1 overflow-hidden"
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
      >
        {/* Scene video */}
        <video
          ref={sceneRef}
          src={`${API}/api/recordings/${recordingId}/video/scene`}
          className="w-full h-full object-contain"
          muted={muted}
          playsInline
          preload="metadata"
        />

        {/* Eye video — draggable PiP (always in DOM, hidden via CSS) */}
        {hasEyeVideo && (
          <div
            className={`absolute rounded-lg overflow-hidden border-2 border-zinc-600
                        shadow-xl shadow-black/50 select-none
                        ${dragging ? "cursor-grabbing border-indigo-400" : "cursor-grab"}`}
            style={{
              left: eyePos.x,
              top: eyePos.y,
              width: 240,
              height: 160,
              zIndex: 10,
              display: showEye ? "block" : "none",
            }}
            onPointerDown={onPointerDown}
          >
            <video
              ref={eyeRef}
              src={`${API}/api/recordings/${recordingId}/video/eye`}
              className="w-full h-full object-cover"
              muted
              playsInline
              preload="metadata"
            />
            <div className="absolute top-1.5 left-2 text-[10px] text-white/70
                            bg-black/50 px-1.5 py-0.5 rounded pointer-events-none">
              Eye Camera
            </div>
          </div>
        )}

        {/* Center play/pause click area */}
        <div
          className="absolute inset-0 flex items-center justify-center cursor-pointer"
          style={{ zIndex: 5 }}
          onClick={togglePlay}
        >
          {!playing && (
            <div className="w-16 h-16 rounded-full bg-black/40 flex items-center justify-center">
              <Play className="w-8 h-8 text-white ml-1" />
            </div>
          )}
        </div>
      </div>

      {/* Controls bar */}
      <div className="flex flex-col gap-2 px-4 py-3 bg-zinc-900 border-t border-zinc-800">
        {/* Seekbar */}
        <div className="relative h-1.5 group">
          <div className="absolute inset-0 bg-zinc-700 rounded-full" />
          <div
            className="absolute inset-y-0 left-0 bg-indigo-500 rounded-full pointer-events-none"
            style={{ width: `${progress}%` }}
          />
          <input
            ref={seekRef}
            type="range"
            min={0}
            max={duration || 0}
            step={0.05}
            value={currentTime}
            onChange={handleSeek}
            className="absolute inset-0 w-full opacity-0 cursor-pointer h-full"
          />
        </div>

        {/* Buttons row */}
        <div className="flex items-center gap-3">
          <button onClick={togglePlay}
            className="text-white hover:text-indigo-400 transition-colors cursor-pointer">
            {playing ? <Pause className="w-5 h-5" /> : <Play className="w-5 h-5" />}
          </button>

          <button onClick={handleMute}
            className="text-zinc-400 hover:text-white transition-colors cursor-pointer">
            {muted ? <VolumeX className="w-4 h-4" /> : <Volume2 className="w-4 h-4" />}
          </button>

          <span className="text-xs text-zinc-400 tabular-nums">
            {formatTime(currentTime)} / {formatTime(duration)}
          </span>

          <div className="flex-1" />

          {/* Speed */}
          <div className="flex items-center gap-1">
            {[0.1, 0.25, 0.5, 1, 2].map((s) => (
              <button
                key={s}
                onClick={() => handleSpeedChange(s)}
                className={`text-xs px-2 py-0.5 rounded transition-colors cursor-pointer
                  ${speed === s
                    ? "bg-indigo-600 text-white"
                    : "text-zinc-400 hover:text-white"}`}
              >
                {s}×
              </button>
            ))}
          </div>

          {/* Eye toggle */}
          {hasEyeVideo && (
            <button
              onClick={() => setShowEye(!showEye)}
              title={showEye ? "Hide eye camera" : "Show eye camera"}
              className={`p-1.5 rounded transition-colors cursor-pointer
                ${showEye ? "text-indigo-400 hover:text-indigo-300" : "text-zinc-600 hover:text-zinc-400"}`}
            >
              {showEye ? <Eye className="w-4 h-4" /> : <EyeOff className="w-4 h-4" />}
            </button>
          )}

          <button
            onClick={() => sceneRef.current?.requestFullscreen()}
            className="text-zinc-400 hover:text-white transition-colors cursor-pointer"
          >
            <Maximize2 className="w-4 h-4" />
          </button>
        </div>
      </div>
    </div>
  );
}
