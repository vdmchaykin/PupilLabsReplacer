import { useEffect, useState } from "react";
import { ArrowLeft } from "lucide-react";
import { api } from "@/lib/api";
import { VideoPlayer } from "@/components/player/VideoPlayer";
import type { RecordingMeta } from "@/types";

interface PlayerPageProps {
  recordingId: string;
  onBack: () => void;
}

export function PlayerPage({ recordingId, onBack }: PlayerPageProps) {
  const [recording, setRecording] = useState<RecordingMeta | null>(null);

  useEffect(() => {
    api.get<RecordingMeta>(`/api/recordings/${recordingId}`)
      .then(setRecording)
      .catch(console.error);
  }, [recordingId]);

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center gap-3 px-4 h-12 border-b border-zinc-800 shrink-0">
        <button
          onClick={onBack}
          className="flex items-center gap-1.5 text-zinc-400 hover:text-white
                     transition-colors text-sm cursor-pointer"
        >
          <ArrowLeft className="w-4 h-4" />
          Back
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
            recordingId={recordingId}
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
