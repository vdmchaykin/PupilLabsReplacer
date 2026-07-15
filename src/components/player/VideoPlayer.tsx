import { useEffect, useRef, useState, useCallback } from "react";
import {
  Play, Pause, Eye, EyeOff, Volume2, VolumeX, Maximize2, ScanEye, CircleDot,
} from "lucide-react";
import type { GazePrediction, PupilData } from "@/types";

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

function findNearest<T extends { timestamp_ns: number }>(preds: T[], targetNs: number): T | null {
  if (preds.length === 0) return null;
  let lo = 0, hi = preds.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (preds[mid].timestamp_ns < targetNs) lo = mid + 1;
    else hi = mid;
  }
  if (lo > 0 && Math.abs(preds[lo - 1].timestamp_ns - targetNs) < Math.abs(preds[lo].timestamp_ns - targetNs)) lo--;
  return preds[lo];
}

export function VideoPlayer({ recordingId, hasEyeVideo }: VideoPlayerProps) {
  const sceneRef = useRef<HTMLVideoElement>(null);
  const eyeRef = useRef<HTMLVideoElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const seekRef = useRef<HTMLInputElement>(null);
  const gazeDotRef = useRef<HTMLDivElement>(null);
  const rafRef = useRef<number>(0);

  // Refs for rAF loop (no re-render needed when these change)
  const predsRef = useRef<GazePrediction[]>([]);
  const naturalSizeRef = useRef({ w: 1920, h: 1080 });

  // Pupil overlay refs
  const eyePipRef = useRef<HTMLDivElement>(null);
  const pupilDotLRef = useRef<HTMLDivElement>(null);
  const pupilDotRRef = useRef<HTMLDivElement>(null);
  const pupilRafRef = useRef<number>(0);
  const pupilsRef = useRef<PupilData[]>([]);
  const eyeNaturalSizeRef = useRef({ w: 384, h: 192 });
  const lastDiamLRef = useRef(20);
  const lastDiamRRef = useRef(20);

  const [playing, setPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [muted, setMuted] = useState(true);
  const [speed, setSpeed] = useState(1);
  const [showEye, setShowEye] = useState(true);
  const [eyePos, setEyePos] = useState<DragPos>({ x: 16, y: 16 });
  const [dragging, setDragging] = useState(false);
  const dragOffset = useRef<DragPos>({ x: 0, y: 0 });

  const [showGaze, setShowGaze] = useState(false);
  const [gazeLoaded, setGazeLoaded] = useState(false);

  const [showPupils, setShowPupils] = useState(false);
  const [pupilsLoaded, setPupilsLoaded] = useState(false);

  // Sync scene → eye on seek
  const syncEye = useCallback((time: number) => {
    if (eyeRef.current) eyeRef.current.currentTime = time;
  }, []);

  const togglePlay = () => {
    const v = sceneRef.current;
    const e = eyeRef.current;
    if (!v) return;
    if (v.paused) { v.play(); e?.play(); }
    else { v.pause(); e?.pause(); }
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
    dragOffset.current = { x: e.clientX - eyePos.x, y: e.clientY - eyePos.y };
  };

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!dragging || !containerRef.current) return;
    const container = containerRef.current.getBoundingClientRect();
    const eyeW = 240, eyeH = 160;
    const x = Math.max(0, Math.min(e.clientX - dragOffset.current.x - container.left, container.width - eyeW));
    const y = Math.max(0, Math.min(e.clientY - dragOffset.current.y - container.top, container.height - eyeH));
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
    const onMeta = () => {
      setDuration(v.duration);
      if (v.videoWidth > 0) naturalSizeRef.current = { w: v.videoWidth, h: v.videoHeight };
    };
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

  // Track eye video natural size for pupil coordinate mapping
  useEffect(() => {
    const e = eyeRef.current;
    if (!e) return;
    const onMeta = () => {
      if (e.videoWidth > 0) eyeNaturalSizeRef.current = { w: e.videoWidth, h: e.videoHeight };
    };
    e.addEventListener("loadedmetadata", onMeta);
    return () => e.removeEventListener("loadedmetadata", onMeta);
  }, [hasEyeVideo]);

  // Load gaze predictions when overlay is first enabled
  useEffect(() => {
    if (!showGaze || gazeLoaded) return;
    fetch(`${API}/api/recordings/${recordingId}/gaze/predictions`)
      .then((r) => r.json())
      .then((data: GazePrediction[]) => {
        predsRef.current = data;
        setGazeLoaded(true);
      })
      .catch(() => {});
  }, [showGaze, gazeLoaded, recordingId]);

  // Load pupils data when overlay is first enabled
  useEffect(() => {
    if (!showPupils || pupilsLoaded) return;
    fetch(`${API}/api/recordings/${recordingId}/gaze/pupils`)
      .then((r) => r.json())
      .then((data: PupilData[]) => {
        pupilsRef.current = data;
        setPupilsLoaded(true);
      })
      .catch(() => {});
  }, [showPupils, pupilsLoaded, recordingId]);

  // rAF loop for pupil overlay on eye PiP
  useEffect(() => {
    if (!showPupils || !showEye) {
      if (pupilDotLRef.current) pupilDotLRef.current.style.display = "none";
      if (pupilDotRRef.current) pupilDotRRef.current.style.display = "none";
      cancelAnimationFrame(pupilRafRef.current);
      return;
    }

    const tick = () => {
      const e = eyeRef.current;
      const dL = pupilDotLRef.current;
      const dR = pupilDotRRef.current;
      const pip = eyePipRef.current;
      const preds = pupilsRef.current;

      if (!e || !dL || !dR || !pip || preds.length === 0) {
        pupilRafRef.current = requestAnimationFrame(tick);
        return;
      }

      // Raw pupils.csv holds one row per eye-video frame, in order, so map by
      // playback position → row index. This is robust to corrupted/non-monotonic
      // timestamps (which would break a findNearest binary search and freeze the
      // overlay on frame 0).
      const dur = e.duration || 1;
      const frac = Math.min(1, Math.max(0, e.currentTime / dur));
      const idx = Math.min(preds.length - 1, Math.round(frac * (preds.length - 1)));
      const pred = preds[idx];

      if (!pred) {
        dL.style.display = "none";
        dR.style.display = "none";
        pupilRafRef.current = requestAnimationFrame(tick);
        return;
      }

      const { w: ew, h: eh } = eyeNaturalSizeRef.current;
      const pw = pip.clientWidth;
      const ph = pip.clientHeight;
      // object-cover: fill container while maintaining aspect ratio (may crop)
      const scale = Math.max(pw / ew, ph / eh);
      const ox = (pw - ew * scale) / 2;
      const oy = (ph - eh * scale) / 2;
      const mid = ew / 2;

      if (pred.diameter_L !== null) lastDiamLRef.current = pred.diameter_L;
      if (pred.diameter_R !== null) lastDiamRRef.current = pred.diameter_R;
      const rL = (lastDiamLRef.current / 2) * scale;
      const rR = (lastDiamRRef.current / 2) * scale;

      if (pred.xL !== null && pred.yL !== null) {
        const x = ox + pred.xL * scale;
        const y = oy + pred.yL * scale;
        dL.style.display = "block";
        dL.style.width = `${rL * 2}px`;
        dL.style.height = `${rL * 2}px`;
        dL.style.left = `${x - rL}px`;
        dL.style.top = `${y - rL}px`;
      } else {
        dL.style.display = "none";
      }

      if (pred.xR !== null && pred.yR !== null) {
        const x = ox + (mid + pred.xR) * scale;
        const y = oy + pred.yR * scale;
        dR.style.display = "block";
        dR.style.width = `${rR * 2}px`;
        dR.style.height = `${rR * 2}px`;
        dR.style.left = `${x - rR}px`;
        dR.style.top = `${y - rR}px`;
      } else {
        dR.style.display = "none";
      }

      pupilRafRef.current = requestAnimationFrame(tick);
    };

    pupilRafRef.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(pupilRafRef.current);
  }, [showPupils, showEye]);

  // rAF loop — updates gaze dot directly in DOM, bypasses React state
  useEffect(() => {
    if (!showGaze) {
      const dot = gazeDotRef.current;
      if (dot) dot.style.display = "none";
      cancelAnimationFrame(rafRef.current);
      return;
    }

    const tick = () => {
      const v = sceneRef.current;
      const dot = gazeDotRef.current;
      const container = containerRef.current;
      const preds = predsRef.current;

      if (!v || !dot || !container || preds.length === 0) {
        rafRef.current = requestAnimationFrame(tick);
        return;
      }

      const t0 = preds[0].timestamp_ns;
      const t1 = preds[preds.length - 1].timestamp_ns;
      const dur = v.duration || 1;
      const targetNs = t0 + (v.currentTime / dur) * (t1 - t0);
      const pred = findNearest(preds, targetNs);

      if (!pred) {
        dot.style.display = "none";
        rafRef.current = requestAnimationFrame(tick);
        return;
      }

      const { w, h } = naturalSizeRef.current;
      const cw = container.clientWidth;
      const ch = container.clientHeight;
      const scale = Math.min(cw / w, ch / h);
      const ox = (cw - w * scale) / 2;
      const oy = (ch - h * scale) / 2;

      const x = ox + pred.pred_gaze_x * scale;
      const y = oy + pred.pred_gaze_y * scale;

      dot.style.display = "block";
      dot.style.left = `${x - 12}px`;
      dot.style.top = `${y - 12}px`;

      rafRef.current = requestAnimationFrame(tick);
    };

    rafRef.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafRef.current);
  }, [showGaze]);

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

        {/* Eye video — draggable PiP */}
        {hasEyeVideo && (
          <div
            ref={eyePipRef}
            className={`absolute rounded-lg overflow-hidden border-2 border-zinc-600
                        shadow-xl shadow-black/50 select-none
                        ${dragging ? "cursor-grabbing border-indigo-400" : "cursor-grab"}`}
            style={{
              left: eyePos.x, top: eyePos.y,
              width: 240, height: 160,
              zIndex: 10,
              display: showEye ? "block" : "none",
            }}
            onPointerDown={onPointerDown}
          >
            <video
              ref={eyeRef}
              src={`${API}/api/recordings/${recordingId}/video/eye`}
              className="w-full h-full object-cover"
              muted playsInline preload="metadata"
            />
            <div className="absolute top-1.5 left-2 text-[10px] text-white/70
                            bg-black/50 px-1.5 py-0.5 rounded pointer-events-none">
              Eye Camera
            </div>
            {/* Pupil dots — left eye (cyan) and right eye (yellow), sized by diameter */}
            <div
              ref={pupilDotLRef}
              className="absolute pointer-events-none rounded-full border-2 border-cyan-400 bg-cyan-400/20 shadow shadow-cyan-400/50"
              style={{ display: "none" }}
            />
            <div
              ref={pupilDotRRef}
              className="absolute pointer-events-none rounded-full border-2 border-yellow-400 bg-yellow-400/20 shadow shadow-yellow-400/50"
              style={{ display: "none" }}
            />
          </div>
        )}

        {/* Gaze dot — always in DOM when showGaze, position updated by rAF */}
        <div
          ref={gazeDotRef}
          className="absolute pointer-events-none"
          style={{ display: "none", width: 24, height: 24, zIndex: 8 }}
        >
          <div className="w-full h-full rounded-full bg-red-500/30 border-2 border-red-500 shadow-lg shadow-red-500/50" />
          <div className="absolute rounded-full bg-red-400" style={{ width: 6, height: 6, left: 9, top: 9 }} />
        </div>

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
                  ${speed === s ? "bg-indigo-600 text-white" : "text-zinc-400 hover:text-white"}`}
              >
                {s}×
              </button>
            ))}
          </div>

          {/* Gaze overlay toggle */}
          <button
            onClick={() => setShowGaze((v) => !v)}
            title={showGaze ? "Hide gaze overlay" : "Show gaze overlay"}
            className={`p-1.5 rounded transition-colors cursor-pointer
              ${showGaze ? "text-red-400 hover:text-red-300" : "text-zinc-600 hover:text-zinc-400"}`}
          >
            <ScanEye className="w-4 h-4" />
          </button>

          {/* Pupil overlay toggle */}
          {hasEyeVideo && (
            <button
              onClick={() => setShowPupils((v) => !v)}
              title={showPupils ? "Hide pupil overlay" : "Show pupil overlay"}
              className={`p-1.5 rounded transition-colors cursor-pointer
                ${showPupils ? "text-cyan-400 hover:text-cyan-300" : "text-zinc-600 hover:text-zinc-400"}`}
            >
              <CircleDot className="w-4 h-4" />
            </button>
          )}

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
