export type Page = "recordings" | "projects" | "export";

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
