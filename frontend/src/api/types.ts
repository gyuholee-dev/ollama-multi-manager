// Shapes of what the backend sends. The backend (Python) is the source of truth; these mirror it by hand.

export type InstanceState = 'running' | 'stopped' | 'starting' | 'stopping' | 'unreachable' | 'crashed';

export interface InstanceOptions {
  gpu: 'auto' | 'cpu' | number;
  context_length: number;
  keep_alive_min: number; // -1 = never unload
  max_loaded_models: number;
  num_parallel: number;
  flash_attention: boolean;
  kv_cache_type: 'f16' | 'q8_0' | 'q4_0';
  models_path: string | null;
  listen: 'local' | 'lan';
  auto_start: boolean;
  idle_stop_min: number;
  api_key: string | null; // a guest only ever sees "********"
  save_requests?: boolean; // keep the content of requests and answers in the instance's request journal
  allowed_models?: string[]; // the models the instance serves; empty or missing = every installed model
}

export interface InstanceStatus {
  state: Exclude<InstanceState, 'unreachable'>; // "unreachable" is worked out in the UI from the metrics
  pid: number | null;
  started_at?: number; // seconds
  exit_code?: number | null;
}

export interface Instance {
  id: number;
  name: string;
  port: number;
  options: InstanceOptions;
  desired_state: 'running' | 'stopped';
  status: InstanceStatus;
}

export interface InstanceCreate {
  name: string;
  port: number;
  options: InstanceOptions;
}

export interface Settings {
  language: string | null;
  theme: 'system' | 'light' | 'dark';
  launch_at_login: boolean;
  minimize_to_tray: boolean;
  external_monitoring_enabled: boolean; // "web access" in the UI
  external_monitoring_port: number;
  external_monitoring_password_set: boolean; // the password itself is never sent
  external_monitoring_metrics_token_set: boolean;
  external_monitoring_metrics_token?: string; // the metrics token itself, shown to be copied; left out for guests
  external_monitoring_session_hours: number; // how long a web sign-in lasts
  refresh_interval_seconds: number;
  monitor_default_ollama: boolean; // show the default Ollama (11434) when it runs
  history_keep_days: number; // how long the per-minute request numbers are kept
  vram_warn_percent: number; // GPU memory use above this is a warning
  ollama_executable_path?: string | null; // left out for guests
  default_models_path?: string | null;
}
/** `external_monitoring_password` is write-only: "" removes the password. */
export type SettingsPatch = Partial<Omit<Settings, 'external_monitoring_password_set' | 'external_monitoring_metrics_token_set'>> & { external_monitoring_password?: string };

export interface WebAccessStatus {
  enabled: boolean;
  port: number;
  password_set: boolean;
  metrics_token_set: boolean;
  active: boolean;
  error: string | null;
}

export interface Info {
  version: string;
  platform: string;
  lan_ip: string;
  external_monitoring: WebAccessStatus;
  guest: boolean; // true on the read-only page of web access without a password
}

// ---- monitoring

export interface GpuDevice {
  index: number;
  uuid: string;
  name: string;
  mem_total: number;
  mem_used: number;
  util_percent: number | null;
  temperature_c: number | null;
  vendor: string; // nvidia | apple | amd | ...
  kind: 'gpu' | 'npu';
  unified: boolean; // memory shared with the CPU: there is no separate VRAM
  env_index: number | null;
  supports: { mem: boolean; util: boolean; temp: boolean; process: boolean; process_util: boolean }; // what this device can report at all
}

export interface SystemStats {
  cpu_percent: number;
  cpu_count: number;
  mem_total: number;
  mem_used: number;
  disk_total: number | null;
  disk_used: number | null;
}

export interface LoadedModel {
  name: string;
  size: number;
  size_vram: number;
  expires_at: string | null;
}

export interface ModelStats {
  requests: number;
  errors: number;
  tokens: number;
  eval_seconds: number;
  latency_avg: number | null;
  tok_per_s: number | null;
}

export interface Perf {
  inflight: number;
  queued: number;
  processing: number;
  requests: number; // finished in the window
  requests_total: number;
  errors: number;
  errors_total: number;
  cancelled: number;
  models: Record<string, ModelStats>;
  latency_avg: number | null;
  ttft_avg: number | null;
  prompt_tokens: number;
  tokens_total: number;
  prompt_tokens_total: number;
  tokens: number;
  eval_seconds: number;
  tok_per_s: number | null;
  window_seconds: number;
}

export interface InstanceMetrics {
  state: string;
  pid: number;
  responsive: boolean;
  cpu_percent: number;
  rss: number;
  vram_bytes: number | null;
  vram_by_gpu: Record<string, number>;
  vram_source: 'nvml' | 'estimated' | null;
  gpu_util_by_gpu: Record<string, number> | null; // the instance's share (%) of each GPU's time; null when the driver cannot tell (Apple silicon, AMD)
  models: LoadedModel[];
  perf: Perf | null;
}

export interface ExternalOllama {
  port: number;
  responsive: boolean;
  models: LoadedModel[];
}

export interface Snapshot {
  ts: number; // seconds
  system: SystemStats;
  gpu: { provider: string; devices: GpuDevice[] };
  instances: Record<string, InstanceMetrics>;
  external: ExternalOllama | null;
}

// ---- logs, downloads, requests

export interface LogEvent {
  type: 'log';
  instance: number; // 0 = the app itself
  level: 'info' | 'warn';
  ts: number; // seconds
  msg: string;
}

export interface PullTask {
  id: string;
  model: string;
  status: 'pulling' | 'paused' | 'error' | 'success';
  status_text: string;
  completed: number;
  total: number;
  error: string | null;
  started_at: number;
  finished_at: number | null;
  percent: number | null;
}

export interface InstalledModel {
  name: string;
  size: number;
  digest?: string;
  modified_at?: string;
  details?: Record<string, unknown>;
}

export interface RequestEntry {
  id: string;
  saved: boolean; // the journal holds what was asked and answered (the instance's "save request content" option was on)
  ts: number; // seconds
  path: string;
  model: string;
  status: number;
  outcome: 'ok' | 'error' | 'cancelled';
  duration: number;
  ttft: number | null;
  tokens: number | null;
  prompt_tokens: number | null;
  client: string;
}

/** One journal entry as the detail call returns it: the list's numbers plus the saved content. */
export interface RequestDetail extends RequestEntry {
  request?: string;
  response?: string;
}

export interface RequestsResponse {
  requests: RequestEntry[];
  models: Record<string, ModelStats>;
}

/** One reading of a running instance as the backend keeps it. */
export interface InstanceSample {
  ts: number; // seconds
  cpu: number; // % of the whole machine
  rss: number; // bytes
  vram: number | null; // bytes
  processing: number;
  queued: number;
}

export interface SeriesPoint {
  minute: number;
  requests: number;
  errors: number;
  cancelled: number;
  tokens: number;
  prompt_tokens: number;
  tok_per_s: number | null;
  latency_avg: number | null;
}

// ---- WebSocket

export type SocketMessage =
  | { type: 'metrics'; data: Snapshot }
  | { type: 'instance'; id: number; status: InstanceStatus }
  | LogEvent
  | { type: 'pull'; task: PullTask }
  | { type: 'pull_removed'; id: string };
