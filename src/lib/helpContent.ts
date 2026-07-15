// Per-page help content shown by the HelpButton in the TopBar.
// Keyed by the same page ids used across the app (see `Page` in types).

export interface HelpSection {
  heading: string;
  body: string;
}

export interface PageHelp {
  title: string;
  intro?: string;
  sections: HelpSection[];
}

export const HELP_CONTENT: Record<string, PageHelp> = {
  projects: {
    title: "Projects",
    intro:
      "Projects group related recordings together. This is the starting point for every analysis.",
    sections: [
      {
        heading: "Create a project",
        body: "Type a name into the field and press Create (or the Enter key). Use one project per study or participant group.",
      },
      {
        heading: "Import a recording",
        body: "Open a project and press Import Recording, then select the native Pupil Labs recording .zip. It is unpacked and added to the project.",
      },
      {
        heading: "Open a recording",
        body: "Click a recording tile to open the Player, or use the play icon to preview it with the raw scene video.",
      },
      {
        heading: "Start an analysis",
        body: "From a recording, jump to Gaze Estimation, Events or Area of Interest. Your selection carries over to that page automatically.",
      },
    ],
  },

  gaze: {
    title: "Gaze Estimation",
    intro:
      "Reconstruct where the participant looked. Work through the three steps in order — each one unlocks the next.",
    sections: [
      {
        heading: "1 · Detect Pupils",
        body: "Runs the pupil detector across both eye videos. Check that the detected ellipses track the pupil, then continue to Calibrate.",
      },
      {
        heading: "2 · Calibrate",
        body: "Uses the calibration markers to fit the mapping from pupil position to scene coordinates. A confidence-gated fixation window aggregates each calibration point; review the fit quality before mapping.",
      },
      {
        heading: "3 · Map Gaze",
        body: "Applies the calibration to the whole recording to produce a gaze point per frame. Once done, gaze is available in the Player, Heatmap and Export.",
      },
      {
        heading: "Revisit a step",
        body: "Click any completed step in the indicator to review or re-run it. Re-running a step may invalidate later steps.",
      },
    ],
  },

  events: {
    title: "Events Annotation",
    intro:
      "Mark timestamps and intervals on the recording timeline (e.g. TMT-A / TMT-B start and end).",
    sections: [
      {
        heading: "Scrub the timeline",
        body: "Drag the slider or the timeline to move through the recording. Hover over an event to see its name and time.",
      },
      {
        heading: "Add an event",
        body: "Type a name and add it at the current time. Quick keys: E adds the next TMT-A event, Shift+E adds test01_end, Shift+R adds test02_end.",
      },
      {
        heading: "Colors & sections",
        body: "Events are grouped into TMT-A, TMT-B and Custom sections. Open the color menu to recolor each section on the timeline.",
      },
      {
        heading: "Seek & delete",
        body: "Click an event to seek to it; use its delete control to remove it. Events feed the segments used by the Heatmap and Export.",
      },
    ],
  },

  aoi: {
    title: "Area of Interest Annotation",
    intro:
      "Define regions on the physical stimulus so gaze can be assigned to areas of interest. This is a three-step flow.",
    sections: [
      {
        heading: "1 · Pick a recording",
        body: "Choose the recording you want to annotate. It provides the scene frames used in the next steps.",
      },
      {
        heading: "2 · Pick a frame",
        body: "Scrub to a frame where the stimulus (with its AprilTags) is clearly visible and flat. This frame is warped to a canonical view using the detected tags.",
      },
      {
        heading: "3 · Draw the areas",
        body: "Draw rectangles or free-form shapes over each region of interest, and name them. Use the pencil tool for free-style shapes. Areas are saved to the recording's aoi state.",
      },
      {
        heading: "Tip",
        body: "Good AprilTag visibility is essential — if the warp looks distorted, go back and pick a cleaner frame.",
      },
    ],
  },

  heatmap: {
    title: "Gaze Heatmap",
    intro:
      "Visualise accumulated gaze on the stimulus. Requires gaze mapping to have been completed first.",
    sections: [
      {
        heading: "Choose a segment",
        body: "Use the segment tabs (General, TMT-A, TMT-B and any custom segments from Events) to restrict the heatmap to that interval.",
      },
      {
        heading: "Play back",
        body: "Use the slider and play controls to watch gaze accumulate over time. Reset returns to the start.",
      },
      {
        heading: "No data?",
        body: "If it says \"No gaze data\", run Gaze Estimation → Map Gaze for this recording first.",
      },
    ],
  },

  player: {
    title: "Player",
    intro: "Play back the scene video with the gaze overlay.",
    sections: [
      {
        heading: "Playback",
        body: "Use the transport controls and timeline to play, pause and seek through the recording.",
      },
      {
        heading: "Gaze overlay",
        body: "If gaze has been mapped, the gaze point is drawn on top of the scene video so you can verify the mapping visually.",
      },
    ],
  },

  export: {
    title: "Export",
    intro: "Export the processed results for downstream analysis.",
    sections: [
      {
        heading: "What gets exported",
        body: "Mapped gaze, events and area-of-interest assignments for the selected recording are written out in a shareable format.",
      },
    ],
  },

  recordings: {
    title: "Recordings",
    intro: "All imported recordings across your projects.",
    sections: [
      {
        heading: "Import",
        body: "Press Import Recording and select a native Pupil Labs .zip to add it.",
      },
      {
        heading: "Open or delete",
        body: "Click a recording to open it in the Player, or use the delete control to remove it.",
      },
    ],
  },
};
