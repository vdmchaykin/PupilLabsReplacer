import { CalendarClock } from "lucide-react";

export function EventsPage() {
  return (
    <div className="flex flex-col items-center justify-center h-full text-zinc-600">
      <CalendarClock className="w-12 h-12 mb-3 opacity-30" />
      <p className="text-sm">Events — coming soon</p>
    </div>
  );
}
