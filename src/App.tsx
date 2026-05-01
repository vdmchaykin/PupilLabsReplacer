import React, { useState } from "react";
import { Sidebar } from "@/components/layout/Sidebar";
import { TopBar } from "@/components/layout/TopBar";
import { RecordingsPage } from "@/pages/RecordingsPage";
import { ProjectsPage } from "@/pages/ProjectsPage";
import { ExportPage } from "@/pages/ExportPage";
import { PlayerPage } from "@/pages/PlayerPage";
import type { Page } from "@/types";

function App() {
  const [page, setPage] = useState<Page>("recordings");
  const [playerRecordingId, setPlayerRecordingId] = useState<string | null>(null);

  const handleOpenPlayer = (id: string) => setPlayerRecordingId(id);
  const handleClosePlayer = () => setPlayerRecordingId(null);

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
    recordings: <RecordingsPage onOpenPlayer={handleOpenPlayer} />,
    projects: <ProjectsPage />,
    export: <ExportPage />,
  };

  return (
    <div className="flex h-screen w-screen bg-zinc-950 text-white overflow-hidden">
      <Sidebar current={page} onChange={setPage} />
      <div className="flex flex-col flex-1 min-w-0">
        <TopBar current={page} />
        <main className="flex-1 overflow-auto">
          {pages[page]}
        </main>
      </div>
    </div>
  );
}

export default App;
