export interface Session {
  id: string;
  agent: string;
  agent_version: string | null;
  title: string | null;
  status: string;
  project_path: string | null;
  repository_url: string | null;
  git_branch: string | null;
  git_sha: string | null;
  model_primary: string | null;
  started_at: number;
  ended_at: number | null;
  duration_ms: number | null;
  total_input_tokens: number;
  total_output_tokens: number;
  total_cache_read: number;
  total_cache_write: number;
  turn_count: number;
  tool_call_count: number;
  first_user_message: string | null;
  source_path: string | null;
  collected_at: number;
}

export interface Message {
  id: string;
  session_id: string;
  parent_id: string | null;
  role: string;
  model: string | null;
  content_text: string | null;
  content_type: string;
  timestamp: number;
  input_tokens: number;
  output_tokens: number;
  cache_read: number;
  cache_write: number;
  seq: number;
}

export interface ToolCall {
  id: string;
  session_id: string;
  message_id: string | null;
  tool_name: string;
  tool_input: string | null;
  tool_output: string | null;
  is_error: number;
  duration_ms: number | null;
  timestamp: number;
}

export interface ModelUsage {
  id?: number;
  session_id: string;
  model: string;
  input_tokens: number;
  output_tokens: number;
  cache_read: number;
  cache_write: number;
  message_count: number;
}

export interface Repository {
  id?: number;
  path: string;
  origin_url: string | null;
  name: string | null;
  session_count: number;
  last_session_at: number | null;
  total_tokens: number;
}

export interface FileEvent {
  id: string;
  tool_call_id: string;
  session_id: string;
  agent: string | null;
  file_path: string;
  repo_path: string | null;
  op: 'read' | 'edit' | 'write' | 'create' | 'delete';
  tool_name: string | null;
  ext: string | null;
  lines_added: number;
  lines_removed: number;
  is_error: number;
  timestamp: number;
}

export interface CollectionState {
  source: string;
  last_file: string | null;
  last_offset: number;
  last_session_id: string | null;
  last_timestamp: number | null;
  updated_at: number;
}
