import { useEffect, useState, type ReactNode } from "react";
import { Film } from "lucide-react";

const API = "http://localhost:8765";

interface RecordingThumbnailProps {
  recordingId: string;
  /** Box classes: size, rounding, and flex behaviour (default: small list row). */
  className?: string;
  /** Fraction (0..1) of the clip to sample the poster frame from. */
  frac?: number;
  /** Optional overlay (e.g. a hover play button) rendered on top of the frame. */
  children?: ReactNode;
}

/**
 * A still preview of a recording's scene video. Renders a server-decoded poster
 * JPEG (`/gaze/frame?frac=…`) as a plain <img>, so the frame appears at once and
 * is cached by the browser — no <video> element that visibly seeks/scrubs to a
 * frame and no loading shimmer.
 */
export function RecordingThumbnail({
  recordingId,
  className = "w-16 h-10 rounded shrink-0",
  frac = 0.15,
  children,
}: RecordingThumbnailProps) {
  const [error, setError] = useState(false);

  // Reset the fallback if this instance is reused for another recording.
  useEffect(() => setError(false), [recordingId]);

  return (
    <div className={`${className} relative overflow-hidden bg-zinc-800`}>
      {error ? (
        <div className="w-full h-full flex items-center justify-center">
          <Film className="w-4 h-4 text-zinc-600" />
        </div>
      ) : (
        <img
          src={`${API}/api/recordings/${recordingId}/gaze/frame?frac=${frac}`}
          className="w-full h-full object-cover"
          alt=""
          draggable={false}
          onError={() => setError(true)}
        />
      )}
      {children}
    </div>
  );
}
