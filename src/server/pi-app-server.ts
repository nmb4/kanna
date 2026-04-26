import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import type { TranscriptEntry } from "../shared/types";
import type {
  HarnessEvent,
  HarnessToolRequest,
  HarnessTurn,
} from "./harness-types";
import {
  type PiEvent,
  type PiRequestId,
  type PiResponse,
  type PiState,
  type PiToolExecutionEndEvent,
  isPiEvent,
  isPiResponse,
  parsePiJsonLine,
} from "./pi-rpc-protocol";

// ---------------------------------------------------------------------------
// Process abstraction
// ---------------------------------------------------------------------------

/** A single model entry returned by Pi's get_available_models. */
export interface PiAvailableModel {
  id: string;
  name: string;
  provider: string;
  reasoning: boolean;
}

interface PiProcess {
  stdin: Writable;
  stdout: Readable;
  stderr: Readable;
  killed?: boolean;
  kill(signal?: NodeJS.Signals | number): void;
  on(event: "close", listener: (code: number | null) => void): this;
  on(event: "error", listener: (error: Error) => void): this;
  once(event: "close", listener: (code: number | null) => void): this;
  once(event: "error", listener: (error: Error) => void): this;
}

type SpawnPiProcess = (cwd: string, extraArgs?: string[]) => PiProcess;

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

interface PendingRequest<TResult> {
  command: string;
  resolve: (value: TResult) => void;
  reject: (error: Error) => void;
}

interface PendingTurn {
  commandId: string;
  queue: AsyncQueue<HarnessEvent>;
  resolved: boolean;
  onToolRequest: (request: HarnessToolRequest) => Promise<unknown>;
  startedToolIds: Set<string>;
  textAccumulator: string;
  aborted: boolean;
}

interface SessionContext {
  chatId: string;
  cwd: string;
  child: PiProcess;
  pendingRequests: Map<PiRequestId, PendingRequest<unknown>>;
  pendingTurn: PendingTurn | null;
  sessionToken: string | null;
  stderrLines: string[];
  closed: boolean;
}

// ---------------------------------------------------------------------------
// Public args interfaces
// ---------------------------------------------------------------------------

export interface StartPiSessionArgs {
  chatId: string;
  cwd: string;
  model: string;
  sessionToken: string | null;
  pendingForkSessionToken?: string | null;
}

export interface StartPiTurnArgs {
  chatId: string;
  model: string;
  content: string;
  planMode: boolean;
  onToolRequest: (request: HarnessToolRequest) => Promise<unknown>;
}

export interface GenerateStructuredArgs {
  cwd: string;
  prompt: string;
  model?: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function timestamped<T extends Omit<TranscriptEntry, "_id" | "createdAt">>(
  entry: T,
  createdAt = Date.now(),
): TranscriptEntry {
  return { _id: randomUUID(), createdAt, ...entry } as TranscriptEntry;
}

function piSystemInitEntry(model: string): TranscriptEntry {
  return timestamped({
    kind: "system_init",
    provider: "pi",
    model,
    tools: [
      "Bash",
      "Write",
      "Edit",
      "Read",
      "Glob",
      "Grep",
      "WebSearch",
      "TodoWrite",
      "AskUserQuestion",
    ],
    agents: [],
    slashCommands: [],
    mcpServers: [],
  });
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

// ---------------------------------------------------------------------------
// Tool call mapping
// ---------------------------------------------------------------------------

function mapPiToolToTranscript(
  toolCallId: string,
  toolName: string,
  args: unknown,
): TranscriptEntry {
  const record = asRecord(args) ?? {};

  switch (toolName) {
    case "bash": {
      const command = asString(record.cmd) ?? asString(record.command) ?? "";
      return timestamped({
        kind: "tool_call",
        tool: {
          kind: "tool",
          toolKind: "bash",
          toolName: "Bash",
          toolId: toolCallId,
          input: { command },
          rawInput: record,
        },
      });
    }
    case "write": {
      const filePath =
        asString(record.file) ??
        asString(record.path) ??
        asString(record.filePath) ??
        "";
      const content = asString(record.content) ?? "";
      return timestamped({
        kind: "tool_call",
        tool: {
          kind: "tool",
          toolKind: "write_file",
          toolName: "Write",
          toolId: toolCallId,
          input: { filePath, content },
          rawInput: record,
        },
      });
    }
    case "edit": {
      const filePath =
        asString(record.file) ??
        asString(record.path) ??
        asString(record.filePath) ??
        "";
      const oldString =
        asString(record.oldText) ??
        asString(record.old_string) ??
        asString(record.oldString) ??
        "";
      const newString =
        asString(record.newText) ??
        asString(record.new_string) ??
        asString(record.newString) ??
        "";
      return timestamped({
        kind: "tool_call",
        tool: {
          kind: "tool",
          toolKind: "edit_file",
          toolName: "Edit",
          toolId: toolCallId,
          input: { filePath, oldString, newString },
          rawInput: record,
        },
      });
    }
    case "read": {
      const filePath =
        asString(record.file) ??
        asString(record.path) ??
        asString(record.filePath) ??
        "";
      return timestamped({
        kind: "tool_call",
        tool: {
          kind: "tool",
          toolKind: "read_file",
          toolName: "Read",
          toolId: toolCallId,
          input: { filePath },
          rawInput: record,
        },
      });
    }
    case "glob": {
      const pattern = asString(record.pattern) ?? asString(record.glob) ?? "";
      return timestamped({
        kind: "tool_call",
        tool: {
          kind: "tool",
          toolKind: "glob",
          toolName: "Glob",
          toolId: toolCallId,
          input: { pattern },
          rawInput: record,
        },
      });
    }
    case "grep": {
      const pattern = asString(record.pattern) ?? asString(record.query) ?? "";
      return timestamped({
        kind: "tool_call",
        tool: {
          kind: "tool",
          toolKind: "grep",
          toolName: "Grep",
          toolId: toolCallId,
          input: { pattern },
          rawInput: record,
        },
      });
    }
    case "web_search":
    case "webSearch": {
      const query = asString(record.query) ?? asString(record.q) ?? "";
      return timestamped({
        kind: "tool_call",
        tool: {
          kind: "tool",
          toolKind: "web_search",
          toolName: "WebSearch",
          toolId: toolCallId,
          input: { query },
          rawInput: record,
        },
      });
    }
    default:
      return timestamped({
        kind: "tool_call",
        tool: {
          kind: "tool",
          toolKind: "unknown_tool",
          toolName: toolName,
          toolId: toolCallId,
          input: { payload: record },
          rawInput: record,
        },
      });
  }
}

// ---------------------------------------------------------------------------
// Tool result extraction
// ---------------------------------------------------------------------------

function extractToolResultText(event: PiToolExecutionEndEvent): string {
  const content = event.result?.content;
  if (Array.isArray(content)) {
    const texts = content
      .filter(
        (part): part is { type: string; text?: string } =>
          typeof part === "object" && part !== null,
      )
      .map((part) => part.text ?? "")
      .filter(Boolean);
    if (texts.length > 0) return texts.join("\n");
  }

  const details = event.result?.details;
  if (details && typeof details === "object") {
    const d = details as Record<string, unknown>;
    // Bash-style result with stdout/stderr
    const stdout = typeof d.stdout === "string" ? d.stdout : "";
    const stderr = typeof d.stderr === "string" ? d.stderr : "";
    const parts = [stdout, stderr].filter(Boolean);
    if (parts.length > 0) return parts.join("\n");
  }

  return "";
}

// ---------------------------------------------------------------------------
// AsyncQueue — same pattern as codex-app-server.ts
// ---------------------------------------------------------------------------

class AsyncQueue<T> implements AsyncIterable<T> {
  private values: T[] = [];
  private resolvers: Array<(value: IteratorResult<T>) => void> = [];
  private done = false;

  push(value: T) {
    if (this.done) return;
    const resolver = this.resolvers.shift();
    if (resolver) {
      resolver({ value, done: false });
      return;
    }
    this.values.push(value);
  }

  finish() {
    if (this.done) return;
    this.done = true;
    while (this.resolvers.length > 0) {
      const resolver = this.resolvers.shift();
      resolver?.({ value: undefined as T, done: true });
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => {
        if (this.values.length > 0) {
          return Promise.resolve({
            value: this.values.shift() as T,
            done: false,
          });
        }
        if (this.done) {
          return Promise.resolve({ value: undefined as T, done: true });
        }
        return new Promise<IteratorResult<T>>((resolve) => {
          this.resolvers.push(resolve);
        });
      },
    };
  }
}

// ---------------------------------------------------------------------------
// PiAppServerManager
// ---------------------------------------------------------------------------

export class PiAppServerManager {
  private readonly sessions = new Map<string, SessionContext>();
  private readonly spawnProcess: SpawnPiProcess;

  constructor(args: { spawnProcess?: SpawnPiProcess } = {}) {
    this.spawnProcess =
      args.spawnProcess ??
      ((cwd, extraArgs = []) =>
        spawn("pi", ["--mode", "rpc", "--no-themes", ...extraArgs], {
          cwd,
          stdio: ["pipe", "pipe", "pipe"],
          env: process.env,
        }) as unknown as PiProcess);
  }

  // -----------------------------------------------------------------------
  // Session management
  // -----------------------------------------------------------------------

  async startSession(args: StartPiSessionArgs): Promise<string | undefined> {
    const existing = this.sessions.get(args.chatId);
    if (
      existing &&
      !existing.closed &&
      existing.cwd === args.cwd &&
      !args.pendingForkSessionToken
    ) {
      return existing.sessionToken ?? undefined;
    }

    if (existing) {
      this.stopSession(args.chatId);
    }

    // Determine if we should resume an existing session
    const sessionPath = args.pendingForkSessionToken ?? args.sessionToken;
    const extraArgs: string[] = [];
    if (sessionPath) {
      extraArgs.push("--session", sessionPath);
    }

    const child = this.spawnProcess(args.cwd, extraArgs);
    const context: SessionContext = {
      chatId: args.chatId,
      cwd: args.cwd,
      child,
      pendingRequests: new Map(),
      pendingTurn: null,
      sessionToken: sessionPath ?? null,
      stderrLines: [],
      closed: false,
    };
    this.sessions.set(args.chatId, context);
    this.attachListeners(context);

    // Try to set the model if one was specified
    if (args.model) {
      try {
        await this.sendRequest(context, "set_model", {
          type: "set_model",
          id: "",
          provider: "auto",
          modelId: args.model,
        });
      } catch {
        // Model setting is best-effort; Pi may not support the model
      }
    }

    // Fetch session state to get the session file path for persistence
    try {
      const state = await this.sendRequest<PiState>(context, "get_state", {
        type: "get_state",
        id: "",
      });
      if (state?.sessionFile) {
        context.sessionToken = state.sessionFile;
      }
    } catch {
      // get_state is best-effort
    }

    return context.sessionToken ?? undefined;
  }

  // -----------------------------------------------------------------------
  // Turn management
  // -----------------------------------------------------------------------

  async startTurn(args: StartPiTurnArgs): Promise<HarnessTurn> {
    const context = this.requireSession(args.chatId);
    if (context.pendingTurn) {
      throw new Error("Pi turn is already running");
    }

    const queue = new AsyncQueue<HarnessEvent>();

    // Push session token if available
    if (context.sessionToken) {
      queue.push({ type: "session_token", sessionToken: context.sessionToken });
    }

    // Push system init entry
    queue.push({ type: "transcript", entry: piSystemInitEntry(args.model) });

    const commandId = randomUUID();
    const pendingTurn: PendingTurn = {
      commandId,
      queue,
      resolved: false,
      onToolRequest: args.onToolRequest,
      startedToolIds: new Set(),
      textAccumulator: "",
      aborted: false,
    };
    context.pendingTurn = pendingTurn;

    try {
      // Send the prompt command to Pi
      await this.sendRequest(context, "prompt", {
        type: "prompt",
        id: commandId,
        message: args.content,
      });
    } catch (error) {
      context.pendingTurn = null;
      queue.finish();
      throw error;
    }

    return {
      provider: "pi",
      stream: queue,
      interrupt: async () => {
        const turn = context.pendingTurn;
        if (!turn) return;

        turn.aborted = true;
        context.pendingTurn = null;
        turn.resolved = true;

        // Push a final result entry for the interrupted turn
        turn.queue.push({
          type: "transcript",
          entry: timestamped({
            kind: "result",
            subtype: "cancelled",
            isError: false,
            durationMs: 0,
            result: "",
          }),
        });
        turn.queue.finish();

        // Send abort command
        try {
          await this.sendRequest(context, "abort", {
            type: "abort",
            id: randomUUID(),
          });
        } catch {
          // abort is best-effort
        }
      },
      close: () => {},
    };
  }

  // -----------------------------------------------------------------------
  // Generate structured (for title generation, commit messages, etc.)
  // -----------------------------------------------------------------------

  async generateStructured(
    args: GenerateStructuredArgs,
  ): Promise<string | null> {
    const chatId = `pi-quick-${randomUUID()}`;
    let turn: HarnessTurn | null = null;
    let assistantText = "";
    let resultText = "";

    try {
      await this.startSession({
        chatId,
        cwd: args.cwd,
        model: args.model ?? "auto",
        sessionToken: null,
      });

      turn = await this.startTurn({
        chatId,
        model: args.model ?? "auto",
        content: args.prompt,
        planMode: false,
        onToolRequest: async () => ({}),
      });

      for await (const event of turn.stream) {
        if (event.type !== "transcript" || !event.entry) continue;
        if (event.entry.kind === "assistant_text") {
          assistantText += assistantText
            ? `\n${event.entry.text}`
            : event.entry.text;
        }
        if (
          event.entry.kind === "result" &&
          !event.entry.isError &&
          event.entry.result.trim()
        ) {
          resultText = event.entry.result;
        }
      }

      const candidate = assistantText.trim() || resultText.trim();
      return candidate || null;
    } finally {
      turn?.close();
      this.stopSession(chatId);
    }
  }

  // -----------------------------------------------------------------------
  // Session teardown
  // -----------------------------------------------------------------------

  stopSession(chatId: string) {
    const context = this.sessions.get(chatId);
    if (!context) return;
    context.closed = true;
    context.pendingTurn?.queue.finish();
    this.sessions.delete(chatId);
    try {
      context.child.kill("SIGKILL");
    } catch {
      // ignore kill failures
    }
  }

  stopAll() {
    for (const chatId of this.sessions.keys()) {
      this.stopSession(chatId);
    }
  }

  // -----------------------------------------------------------------------
  // Internal helpers
  // -----------------------------------------------------------------------

  private requireSession(chatId: string): SessionContext {
    const context = this.sessions.get(chatId);
    if (!context || context.closed) {
      throw new Error("Pi session not started");
    }
    return context;
  }

  // -----------------------------------------------------------------------
  // Process listeners
  // -----------------------------------------------------------------------

  private attachListeners(context: SessionContext) {
    const stdoutLines = createInterface({ input: context.child.stdout });
    void (async () => {
      for await (const line of stdoutLines) {
        const parsed = parsePiJsonLine(line);
        if (!parsed) continue;

        if (isPiResponse(parsed)) {
          this.handleResponse(context, parsed);
          continue;
        }

        if (isPiEvent(parsed)) {
          this.handleEvent(context, parsed);
        }
      }
    })();

    const stderrLines = createInterface({ input: context.child.stderr });
    void (async () => {
      for await (const line of stderrLines) {
        if (line.trim()) {
          context.stderrLines.push(line.trim());
        }
      }
    })();

    context.child.on("error", (error) => {
      this.failContext(context, error.message);
    });

    context.child.on("close", (code) => {
      if (context.closed) return;
      queueMicrotask(() => {
        if (context.closed) return;
        const message =
          context.stderrLines.at(-1) ??
          `Pi process exited with code ${code ?? 1}`;
        this.failContext(context, message);
      });
    });
  }

  // -----------------------------------------------------------------------
  // Response handling
  // -----------------------------------------------------------------------

  private handleResponse(context: SessionContext, response: PiResponse) {
    const pending = context.pendingRequests.get(response.id);
    if (!pending) return;
    context.pendingRequests.delete(response.id);

    if (!response.success || response.error) {
      pending.reject(
        new Error(
          `${pending.command} failed: ${response.error ?? "Unknown error"}`,
        ),
      );
      return;
    }
    pending.resolve(response.data);
  }

  // -----------------------------------------------------------------------
  // Event handling — translate Pi events into HarnessEvents
  // -----------------------------------------------------------------------

  private handleEvent(context: SessionContext, event: PiEvent) {
    const pendingTurn = context.pendingTurn;
    // Most events require an active turn
    switch (event.type) {
      case "agent_start":
        // Agent loop has started — nothing special to emit
        return;

      case "agent_end": {
        // Agent loop has finished — this is the terminal signal
        if (pendingTurn && !pendingTurn.resolved) {
          pendingTurn.resolved = true;
          context.pendingTurn = null;

          // Flush any accumulated text
          this.flushText(pendingTurn);

          pendingTurn.queue.push({
            type: "transcript",
            entry: timestamped({
              kind: "result",
              subtype: pendingTurn.aborted ? "cancelled" : "success",
              isError: false,
              durationMs: 0,
              result: "",
            }),
          });
          pendingTurn.queue.finish();
        }
        return;
      }

      case "turn_end":
        // A sub-step has ended (agent may loop). Flush text so far.
        if (pendingTurn && !pendingTurn.resolved) {
          this.flushText(pendingTurn);
        }
        return;

      case "message_update": {
        if (!pendingTurn || pendingTurn.resolved) return;
        const inner = event.assistantMessageEvent;
        if (!inner) return;

        switch (inner.type) {
          case "text_delta": {
            pendingTurn.textAccumulator += inner.delta ?? "";
            return;
          }
          case "thinking_delta": {
            // Treat thinking as assistant text with a subtle prefix
            pendingTurn.textAccumulator += inner.delta ?? "";
            return;
          }
          // toolcall_start/delta/end are streaming metadata — we handle the
          // tool at execution time (tool_execution_start/end) for richer info.
          default:
            return;
        }
      }

      case "tool_execution_start": {
        if (!pendingTurn || pendingTurn.resolved) return;
        // Flush any accumulated text before the tool call
        this.flushText(pendingTurn);

        const toolCallId = event.toolCallId;
        if (pendingTurn.startedToolIds.has(toolCallId)) return;
        pendingTurn.startedToolIds.add(toolCallId);

        const entry = mapPiToolToTranscript(
          toolCallId,
          event.toolName,
          event.args,
        );
        pendingTurn.queue.push({ type: "transcript", entry });
        return;
      }

      case "tool_execution_update":
        // Partial output — we ignore these and wait for tool_execution_end
        return;

      case "tool_execution_end": {
        if (!pendingTurn || pendingTurn.resolved) return;
        this.handleToolExecutionEnd(pendingTurn, event);
        return;
      }

      case "auto_compaction_start": {
        if (pendingTurn && !pendingTurn.resolved) {
          pendingTurn.queue.push({
            type: "transcript",
            entry: timestamped({ kind: "compact_boundary" }),
          });
        }
        return;
      }

      case "auto_compaction_end":
        return;

      case "auto_retry_start":
      case "auto_retry_end":
        // Best-effort retries — nothing to surface in the transcript
        return;

      default:
        return;
    }
  }

  // -----------------------------------------------------------------------
  // Tool execution end
  // -----------------------------------------------------------------------

  private handleToolExecutionEnd(
    pendingTurn: PendingTurn,
    event: PiToolExecutionEndEvent,
  ) {
    const text = extractToolResultText(event);

    pendingTurn.queue.push({
      type: "transcript",
      entry: timestamped({
        kind: "tool_result",
        toolId: event.toolCallId,
        content: text || event.result,
        isError: event.isError,
      }),
    });
  }

  // -----------------------------------------------------------------------
  // Text accumulation
  // -----------------------------------------------------------------------

  private flushText(pendingTurn: PendingTurn) {
    if (!pendingTurn.textAccumulator) return;
    const text = pendingTurn.textAccumulator;
    pendingTurn.textAccumulator = "";

    pendingTurn.queue.push({
      type: "transcript",
      entry: timestamped({
        kind: "assistant_text",
        text,
      }),
    });
  }

  // -----------------------------------------------------------------------
  // Context failure
  // -----------------------------------------------------------------------

  private failContext(context: SessionContext, message: string) {
    const pendingTurn = context.pendingTurn;
    if (pendingTurn && !pendingTurn.resolved) {
      pendingTurn.queue.push({
        type: "transcript",
        entry: timestamped({
          kind: "result",
          subtype: "error",
          isError: true,
          durationMs: 0,
          result: message,
        }),
      });
      pendingTurn.queue.finish();
      context.pendingTurn = null;
    }

    for (const pending of context.pendingRequests.values()) {
      pending.reject(new Error(message));
    }
    context.pendingRequests.clear();
    context.closed = true;
  }

  // -----------------------------------------------------------------------
  // Dynamic model discovery
  // -----------------------------------------------------------------------

  /**
   * Fetch the list of models available to Pi by spawning a short-lived
   * temporary process and calling `get_available_models`.
   */
  async fetchAvailableModels(cwd?: string): Promise<PiAvailableModel[]> {
    const workDir = cwd ?? process.cwd();
    const child = this.spawnProcess(workDir, []);

    try {
      // Collect stdout lines until we get a response to our command
      const result = await new Promise<PiAvailableModel[]>(
        (resolve, reject) => {
          const timeout = setTimeout(() => {
            reject(new Error("Timed out fetching Pi models"));
          }, 15_000);

          const lineReader = createInterface({ input: child.stdout });
          const pendingIds = new Set<PiRequestId>();

          const commandId = randomUUID();
          pendingIds.add(commandId);

          lineReader.on("line", (line: string) => {
            const parsed = parsePiJsonLine(line);
            if (!parsed) {
              // Non-JSON preamble line — ignore
              return;
            }

            if (isPiResponse(parsed) && pendingIds.has(parsed.id)) {
              clearTimeout(timeout);
              pendingIds.delete(parsed.id);

              if (!parsed.success) {
                reject(
                  new Error(
                    `get_available_models failed: ${parsed.error ?? "unknown"}`,
                  ),
                );
                return;
              }

              const data = parsed.data as
                | { models?: Array<Record<string, unknown>> }
                | undefined;
              const raw = data?.models ?? [];
              const models: PiAvailableModel[] = raw.map((m) => ({
                id: String(m.id ?? ""),
                name: String(m.name ?? m.id ?? ""),
                provider: String(m.provider ?? ""),
                reasoning: Boolean(m.reasoning),
              }));
              resolve(models);
            }
          });

          child.on("error", (err) => {
            clearTimeout(timeout);
            reject(err);
          });

          child.on("close", (code) => {
            clearTimeout(timeout);
            if (pendingIds.size > 0) {
              reject(
                new Error(
                  `Pi process exited with code ${code} before responding`,
                ),
              );
            }
          });

          // Send the command
          child.stdin.write(
            `${JSON.stringify({ type: "get_available_models", id: commandId })}\n`,
          );
        },
      );

      return result;
    } finally {
      try {
        child.kill("SIGKILL");
      } catch {
        /* best effort */
      }
    }
  }

  // -----------------------------------------------------------------------
  // Request/response transport
  // -----------------------------------------------------------------------

  private async sendRequest<TResult>(
    context: SessionContext,
    command: string,
    payload: Record<string, unknown>,
  ): Promise<TResult> {
    const id = (payload.id as PiRequestId) || randomUUID();
    payload.id = id;

    const promise = new Promise<TResult>((resolve, reject) => {
      context.pendingRequests.set(id, {
        command,
        resolve: resolve as (value: unknown) => void,
        reject,
      });
    });

    this.writeMessage(context, payload);
    return await promise;
  }

  private writeMessage(
    context: SessionContext,
    message: Record<string, unknown>,
  ) {
    context.child.stdin.write(`${JSON.stringify(message)}\n`);
  }
}
