export function formatDuration(seconds?: number): string {
  if (!seconds) return "—";
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

export function formatDate(ns?: number): string {
  if (!ns) return "—";
  return new Date(ns / 1_000_000).toLocaleString();
}
