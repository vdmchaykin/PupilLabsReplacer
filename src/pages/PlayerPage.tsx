import { useEffect, useState } from "react";
import { ArrowLeft, Play, ChevronRight } from "lucide-react";
import { api } from "@/lib/api";
import { formatDuration, formatDate } from "@/lib/utils";
import { VideoPlayer } from "@/components/player/VideoPlayer";
import { RecordingThumbnail } from "@/components/player/RecordingThumbnail";
import type { RecordingMeta } from "@/types";

interface PlayerPageProps {
  /** When provided, the player opens directly on this recording (overlay mode). */
  recordingId?: string;
  /** Pre-selected recording when navigating in from another page. */
  initialRecording?: RecordingMeta;
  /** Shown as a "Back" button in overlay mode; when absent, a recording picker is used instead. */
  onBack?: () => void;
}

export function PlayerPage({ recordingId, initialRecording, onBack }: PlayerPageProps) {
  const [recordings, setRecordings] = useState<RecordingMeta[]>([]);
  const [loadingRecs, setLoadingRecs] = useState(true);
  const [selectedId, setSelectedId] = useState<string | null>(recordingId ?? initialRecording?.id ?? null);
  const [recording, setRecording] = useState<RecordingMeta | null>(initialRecording ?? null);

  useEffect(() => {
    api.get<RecordingMeta[]>("/api/recordings")
      .then(setRecordings)
      .catch(console.error)
      .finally(() => setLoadingRecs(false));
  }, []);

  useEffect(() => {
    if (!selectedId) {
      setRecording(null);
      return;
    }
    api.get<RecordingMeta>(`/api/recordings/${selectedId}`)
      .then(setRecording)
      .catch(console.error);
  }, [selectedId]);

  // In overlay mode (opened from another flow), the parent controls dismissal.
  const overlay = !!onBack;
  const handleBack = () => {
    if (onBack) onBack();
    else setSelectedId(null);
  };

  if (!selectedId) {
    return (
      <div className="flex h-full">
        <div className="w-80 border-r border-zinc-800 flex flex-col">
          <div className="flex-1 overflow-auto">
            {loadingRecs ? (
              <p className="text-zinc-500 text-xs p-4">Loading…</p>
            ) : recordings.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-12 text-zinc-600">
                <Play className="w-8 h-8 mb-2 opacity-30" />
                <p className="text-xs">No recordings yet</p>
              </div>
            ) : (
              recordings.map((rec) => (
                <button
                  key={rec.id}
                  onClick={() => setSelectedId(rec.id)}
                  className="w-full flex items-center gap-3 px-4 py-3 text-left
                             border-b border-zinc-800/50 hover:bg-zinc-900 transition-colors
                             group cursor-pointer"
                >
                  <RecordingThumbnail recordingId={rec.id} />
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
          <p className="text-sm">Select a recording to play the video</p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center gap-3 px-4 h-12 border-b border-zinc-800 shrink-0">
        <button
          onClick={handleBack}
          className="flex items-center gap-1.5 text-zinc-400 hover:text-white
                     transition-colors text-sm cursor-pointer"
        >
          <ArrowLeft className="w-4 h-4" />
          {overlay ? "Back" : "All Recordings"}
        </button>
        {recording && (
          <>
            <span className="text-zinc-700">|</span>
            <span className="text-sm text-white font-medium">{recording.name}</span>
            {recording.wearer_name && (
              <span className="text-xs text-zinc-500">{recording.wearer_name}</span>
            )}
          </>
        )}
      </div>

      <div className="flex-1 overflow-hidden">
        {recording ? (
          <VideoPlayer
            recordingId={selectedId}
            hasEyeVideo={!!recording.eye_video}
          />
        ) : (
          <div className="flex items-center justify-center h-full text-zinc-500 text-sm">
            Loading…
          </div>
        )}
      </div>
    </div>
  );
}
