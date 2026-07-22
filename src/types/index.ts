export type Page = "projects" | "gaze" | "player" | "export" | "events" | "aoi" | "surface" | "visualisation";

/** Pages that can be opened for a specific recording. */
export type NavPage = "gaze" | "events" | "aoi" | "surface" | "visualisation";

export interface RecordingEvent {
  index: number;
  timestamp_s: number;
  name: string;
}

export interface NavState {
  page: Page;
  recordingId?: string;
}

export interface Project {
  id: string;
  name: string;
  description?: string;
  created_at?: string;
  recording_count: number;
}

export type GazeStep = "detect" | "calibrate" | "map" | "fixations";

export interface GazeJobStatus {
  status: "idle" | "running" | "done" | "error";
  progress?: number;
  total?: number;
  message?: string;
}

export interface CalibrationPoint {
  point_id: number;
  timestamp_ns: number;
  gaze_x: number;
  gaze_y: number;
}

export interface GazePrediction {
  timestamp_ns: number;
  pred_gaze_x: number;
  pred_gaze_y: number;
  paper_x: number | null;
  paper_y: number | null;
}

export interface PupilData {
  timestamp_ns: number;
  xL: number | null;
  yL: number | null;
  diameter_L: number | null;
  // Fitted-ellipse geometry (OpenCV fitEllipse): A/B are full axis lengths in
  // eye-video pixels, angle is the rotation of the A axis in degrees.
  A_L: number | null;
  B_L: number | null;
  angle_L: number | null;
  xR: number | null;
  yR: number | null;
  diameter_R: number | null;
  A_R: number | null;
  B_R: number | null;
  angle_R: number | null;
}

export interface GazeAnalysisState {
  pupils_done: boolean;
  calibration_done: boolean;
  mapping_done: boolean;
  fixations_done: boolean;
  calibration_points: CalibrationPoint[];
}

export interface Fixation {
  fixation_id: number;
  start_ts_ns: number;
  end_ts_ns: number;
  duration_ms: number;
  x_px: number;
  y_px: number;
  on_surface: boolean;
  norm_x: number | null;
  norm_y: number | null;
}

export interface FixationResult {
  n_fixations: number;
  mean_duration_ms: number;
  median_duration_ms: number;
  max_duration_ms: number;
  pct_time_fixating: number;
  n_on_surface: number;
  pct_on_surface: number;
  max_dispersion_deg: number;
  min_duration_ms: number;
  max_gap_ms: number;
}

export interface ProjectRef {
  id: string;
  name: string;
}

export interface RecordingMeta {
  id: string;
  name: string;
  wearer_name?: string;
  start_time?: number;
  duration_ns?: number;
  duration_sec?: number;
  gaze_frequency?: number;
  device_serial?: string;
  app_version?: string;
  folder_path: string;
  scene_video?: string;
  eye_video?: string;
  has_gaze_result: boolean;
  imported_at?: string;
  projects?: ProjectRef[];
}
