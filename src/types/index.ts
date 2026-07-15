export type Page = "projects" | "gaze" | "export" | "events" | "aoi" | "heatmap";

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

export type GazeStep = "detect" | "calibrate" | "map";

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
  xR: number | null;
  yR: number | null;
  diameter_R: number | null;
}

export interface GazeAnalysisState {
  pupils_done: boolean;
  calibration_done: boolean;
  mapping_done: boolean;
  calibration_points: CalibrationPoint[];
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
}
