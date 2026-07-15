import React, { useState } from "react";
import { ThemeProvider } from "@/lib/theme";
import { Sidebar } from "@/components/layout/Sidebar";
import { TopBar } from "@/components/layout/TopBar";
import { ProjectsPage } from "@/pages/ProjectsPage";
import { GazePage } from "@/pages/GazePage";
import { ExportPage } from "@/pages/ExportPage";
import { PlayerPage } from "@/pages/PlayerPage";
import { EventsPage } from "@/pages/EventsPage";
import { AoiPage } from "@/pages/AoiPage";
import { PaperGazePage } from "@/pages/PaperGazePage";
import type { Page, RecordingMeta } from "@/types";

function AppInner() {
  const [page, setPage] = useState<Page>("projects");
  const [playerRecordingId, setPlayerRecordingId] = useState<string | null>(null);
  const [navRecording, setNavRecording] = useState<RecordingMeta | null>(null);

  const handleOpenPlayer = (id: string) => setPlayerRecordingId(id);
  const handleClosePlayer = () => setPlayerRecordingId(null);
  const handleNavigate = (p: "gaze" | "events" | "aoi", recording: RecordingMeta) => {
    setNavRecording(recording);
    setPage(p);
  };

  if (playerRecordingId) {
    return (
      <div className="flex h-screen w-screen bg-zinc-950 text-white overflow-hidden">
        <Sidebar current={page} onChange={(p) => { handleClosePlayer(); setPage(p); }} />
        <div className="flex flex-col flex-1 min-w-0">
          <PlayerPage recordingId={playerRecordingId} onBack={handleClosePlayer} />
        </div>
      </div>
    );
  }

  const pages: Record<Page, React.ReactElement> = {
    projects: <ProjectsPage onNavigate={handleNavigate} onOpenPlayer={handleOpenPlayer} />,
    gaze: <GazePage onOpenPlayer={handleOpenPlayer} initialRecording={navRecording ?? undefined} />,
    export: <ExportPage />,
    events: <EventsPage initialRecording={navRecording ?? undefined} />,
    aoi: <AoiPage initialRecording={navRecording ?? undefined} />,
    heatmap: <PaperGazePage initialRecording={navRecording ?? undefined} />,
  };

  const handleSidebarChange = (p: Page) => {
    setNavRecording(null);
    setPage(p);
  };

  return (
    <div className="flex h-screen w-screen bg-zinc-950 text-white overflow-hidden">
      <Sidebar current={page} onChange={handleSidebarChange} />
      <div className="flex flex-col flex-1 min-w-0">
        <TopBar current={page} />
        <main className="flex-1 overflow-auto">
          {pages[page]}
        </main>
      </div>
    </div>
  );
}

function App() {
  return (
    <ThemeProvider>
      <AppInner />
    </ThemeProvider>
  );
}

export default App;
