// Typed subset of Pi's NDJSON RPC protocol.
// Used when launching `pi --mode rpc --no-themes` for stdio communication.
// Keep names and field shapes aligned with the pi-acp adapter wire format.

// ---------------------------------------------------------------------------
// IDs
// ---------------------------------------------------------------------------

/** Correlation ID used to match commands to responses. */
export type PiRequestId = string | number

// ---------------------------------------------------------------------------
// Shared value types
// ---------------------------------------------------------------------------

/** Thinking/reasoning levels supported by Pi. */
export type PiThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh"

/** Information about the currently active model. */
export interface PiModelInfo {
  provider: string
  id: string
}

/**
 * Full session state returned by the `get_state` response.
 */
export interface PiState {
  sessionId: string
  sessionFile: string
  messageCount: number
  model: PiModelInfo
  thinkingLevel: PiThinkingLevel
  steeringMode: string
  followUpMode: string
  autoCompactionEnabled: boolean
}

// ---------------------------------------------------------------------------
// Commands (client → pi) — written to stdin as NDJSON
// ---------------------------------------------------------------------------

/** Send a user prompt, optionally with base64-encoded images. */
export interface PiPromptCommand {
  type: "prompt"
  id: PiRequestId
  message: string
  images?: string[]
}

/** Abort the current in-progress operation. */
export interface PiAbortCommand {
  type: "abort"
  id: PiRequestId
}

/** Request the current session state. */
export interface PiGetStateCommand {
  type: "get_state"
  id: PiRequestId
}

/** List the models available to the current session. */
export interface PiGetAvailableModelsCommand {
  type: "get_available_models"
  id: PiRequestId
}

/** Switch the active model for the session. */
export interface PiSetModelCommand {
  type: "set_model"
  id: PiRequestId
  provider: string
  modelId: string
}

/** Change the thinking/reasoning level. */
export interface PiSetThinkingLevelCommand {
  type: "set_thinking_level"
  id: PiRequestId
  level: PiThinkingLevel
}

/** Retrieve the full message history for the session. */
export interface PiGetMessagesCommand {
  type: "get_messages"
  id: PiRequestId
}

/** Retrieve the list of available slash commands. */
export interface PiGetCommandsCommand {
  type: "get_commands"
  id: PiRequestId
}

/** Union of all commands the client can send to Pi. */
export type PiCommand =
  | PiPromptCommand
  | PiAbortCommand
  | PiGetStateCommand
  | PiGetAvailableModelsCommand
  | PiSetModelCommand
  | PiSetThinkingLevelCommand
  | PiGetMessagesCommand
  | PiGetCommandsCommand

// ---------------------------------------------------------------------------
// Responses (pi → client) — correlated by `id` to a command
// ---------------------------------------------------------------------------

/**
 * Generic response envelope.  `data` shape depends on `command`;
 * `error` is present when `success` is false.
 */
export interface PiResponse<TData = unknown> {
  type: "response"
  id: PiRequestId
  command: string
  success: boolean
  data?: TData
  error?: string
}

// ---------------------------------------------------------------------------
// Tool call descriptor (used inside streaming events)
// ---------------------------------------------------------------------------

export interface PiToolCall {
  id: string
  name: string
  /** JSON-encoded argument string; may be partial during streaming. */
  arguments: string
}

// ---------------------------------------------------------------------------
// Assistant message events — nested inside `message_update`
// ---------------------------------------------------------------------------

export interface PiTextDeltaEvent {
  type: "text_delta"
  delta: string
}

export interface PiThinkingDeltaEvent {
  type: "thinking_delta"
  delta: string
}

export interface PiToolCallStartEvent {
  type: "toolcall_start"
  toolCall: PiToolCall
}

export interface PiToolCallDeltaEvent {
  type: "toolcall_delta"
  toolCall: PiToolCall
}

export interface PiToolCallEndEvent {
  type: "toolcall_end"
  toolCall: PiToolCall
}

/** Union of all streaming assistant-message events. */
export type PiAssistantMessageEvent =
  | PiTextDeltaEvent
  | PiThinkingDeltaEvent
  | PiToolCallStartEvent
  | PiToolCallDeltaEvent
  | PiToolCallEndEvent

// ---------------------------------------------------------------------------
// Tool execution content
// ---------------------------------------------------------------------------

export interface PiToolContentPart {
  type: string
  text?: string
}

// ---------------------------------------------------------------------------
// Events (pi → client) — async signals during a prompt turn
// ---------------------------------------------------------------------------

/** The agent loop has started processing a prompt. */
export interface PiAgentStartEvent {
  type: "agent_start"
}

/** The agent loop has finished (terminal signal). */
export interface PiAgentEndEvent {
  type: "agent_end"
}

/** A sub-step / tool-use turn has ended; more may follow. */
export interface PiTurnEndEvent {
  type: "turn_end"
}

/** An automatic retry is about to be attempted. */
export interface PiAutoRetryStartEvent {
  type: "auto_retry_start"
  attempt: number
  maxAttempts: number
  delayMs: number
  errorMessage?: string
}

/** The automatic retry attempt has concluded. */
export interface PiAutoRetryEndEvent {
  type: "auto_retry_end"
}

/** Context auto-compaction is starting. */
export interface PiAutoCompactionStartEvent {
  type: "auto_compaction_start"
}

/** Context auto-compaction has completed. */
export interface PiAutoCompactionEndEvent {
  type: "auto_compaction_end"
}

/** Wraps a streaming assistant-message event (text, thinking, tool calls). */
export interface PiMessageUpdateEvent {
  type: "message_update"
  assistantMessageEvent: PiAssistantMessageEvent
}

/** A tool has begun executing. */
export interface PiToolExecutionStartEvent {
  type: "tool_execution_start"
  toolCallId: string
  toolName: string
  args: unknown
}

/** Partial output from a running tool. */
export interface PiToolExecutionUpdateEvent {
  type: "tool_execution_update"
  toolCallId: string
  partialResult: {
    content: PiToolContentPart[]
  }
}

/** A tool has finished executing. */
export interface PiToolExecutionEndEvent {
  type: "tool_execution_end"
  toolCallId: string
  isError: boolean
  result: {
    content: PiToolContentPart[]
    details?: Record<string, unknown>
  }
}

/** Union of all async events Pi can emit. */
export type PiEvent =
  | PiAgentStartEvent
  | PiAgentEndEvent
  | PiTurnEndEvent
  | PiAutoRetryStartEvent
  | PiAutoRetryEndEvent
  | PiAutoCompactionStartEvent
  | PiAutoCompactionEndEvent
  | PiMessageUpdateEvent
  | PiToolExecutionStartEvent
  | PiToolExecutionUpdateEvent
  | PiToolExecutionEndEvent

// ---------------------------------------------------------------------------
// Broad inbound type
// ---------------------------------------------------------------------------

/** Anything Pi sends to the client over stdout. */
export type PiInboundMessage = PiResponse | PiEvent

// ---------------------------------------------------------------------------
// Event type discriminant set (for type guards)
// ---------------------------------------------------------------------------

const PI_EVENT_TYPES = new Set<string>([
  "agent_start",
  "agent_end",
  "turn_end",
  "auto_retry_start",
  "auto_retry_end",
  "auto_compaction_start",
  "auto_compaction_end",
  "message_update",
  "tool_execution_start",
  "tool_execution_update",
  "tool_execution_end",
])

// ---------------------------------------------------------------------------
// Type guards
// ---------------------------------------------------------------------------

/** Returns `true` when the value is a Pi RPC response envelope. */
export function isPiResponse(value: unknown): value is PiResponse {
  if (!value || typeof value !== "object") return false
  const candidate = value as Record<string, unknown>
  return (
    candidate.type === "response"
    && ("id" in candidate)
    && ("command" in candidate)
    && typeof candidate.success === "boolean"
  )
}

/** Returns `true` when the value is a recognised Pi async event. */
export function isPiEvent(value: unknown): value is PiEvent {
  if (!value || typeof value !== "object") return false
  const candidate = value as Record<string, unknown>
  return (
    typeof candidate.type === "string"
    && PI_EVENT_TYPES.has(candidate.type)
  )
}

/** Returns `true` when the value is a `message_update` event. */
export function isPiMessageUpdate(value: unknown): value is PiMessageUpdateEvent {
  if (!value || typeof value !== "object") return false
  const candidate = value as Record<string, unknown>
  return (
    candidate.type === "message_update"
    && "assistantMessageEvent" in candidate
  )
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Safely parse a single NDJSON line from Pi's stdout.
 * Returns the typed message, or `undefined` if the line is blank / invalid.
 */
export function parsePiJsonLine(line: string): PiInboundMessage | undefined {
  const trimmed = line.trim()
  if (!trimmed) return undefined
  try {
    const parsed: unknown = JSON.parse(trimmed)
    if (isPiResponse(parsed) || isPiEvent(parsed)) {
      return parsed
    }
    return undefined
  } catch {
    return undefined
  }
}
