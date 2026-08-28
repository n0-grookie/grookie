import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

interface StateFile {
  agentId?: string;
  agentPromptVersion?: number;
  conversations: Record<string, string>;
  processedMessages?: Record<string, number>;
}

export class StateStore {
  private state: StateFile = { conversations: {}, processedMessages: {} };
  private writeQueue = Promise.resolve();

  public constructor(private readonly path: string) {}

  public async load(): Promise<void> {
    try {
      const contents = await readFile(this.path, "utf8");
      const parsed: unknown = JSON.parse(contents);
      if (!isStateFile(parsed)) {
        throw new Error("state file has an invalid shape");
      }
      this.state = parsed;
    } catch (error: unknown) {
      if (isMissingFile(error)) return;
      throw error;
    }
  }

  public get agentId(): string | undefined {
    return this.state.agentId;
  }

  public setAgentId(agentId: string): void {
    this.state.agentId = agentId;
  }

  public get agentPromptVersion(): number | undefined {
    return this.state.agentPromptVersion;
  }

  public setAgentPromptVersion(version: number): void {
    this.state.agentPromptVersion = version;
  }

  public resetConversations(): void {
    this.state.conversations = {};
  }

  public conversationId(threadId: string): string | undefined {
    return this.state.conversations[threadId];
  }

  public setConversationId(threadId: string, conversationId: string): void {
    this.state.conversations[threadId] = conversationId;
  }

  public hasProcessedMessage(messageId: string): boolean {
    return this.state.processedMessages?.[messageId] !== undefined;
  }

  public markMessageProcessed(messageId: string, timestamp: number): void {
    (this.state.processedMessages ??= {})[messageId] = timestamp;
  }

  public pruneProcessedMessages(cutoff: number): void {
    if (!this.state.processedMessages) return;
    for (const [messageId, timestamp] of Object.entries(
      this.state.processedMessages,
    )) {
      if (timestamp < cutoff) delete this.state.processedMessages[messageId];
    }
  }

  public async save(): Promise<void> {
    const write = async (): Promise<void> => {
      await mkdir(dirname(this.path), { recursive: true });
      const temporaryPath = `${this.path}.tmp`;
      await writeFile(temporaryPath, `${JSON.stringify(this.state, null, 2)}\n`, {
        encoding: "utf8",
        mode: 0o600,
      });
      await rename(temporaryPath, this.path);
    };

    const nextWrite = this.writeQueue.then(write, write);
    this.writeQueue = nextWrite.catch(() => undefined);
    await nextWrite;
  }
}

function isStateFile(value: unknown): value is StateFile {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  if (record.agentId !== undefined && typeof record.agentId !== "string") {
    return false;
  }
  if (
    record.agentPromptVersion !== undefined &&
    (typeof record.agentPromptVersion !== "number" ||
      !Number.isSafeInteger(record.agentPromptVersion) ||
      record.agentPromptVersion <= 0)
  ) {
    return false;
  }
  if (typeof record.conversations !== "object" || record.conversations === null) {
    return false;
  }
  if (!Object.values(record.conversations).every((id) => typeof id === "string")) {
    return false;
  }
  if (record.processedMessages === undefined) return true;
  if (
    typeof record.processedMessages !== "object" ||
    record.processedMessages === null
  ) {
    return false;
  }
  return Object.values(record.processedMessages).every(
    (timestamp) => typeof timestamp === "number",
  );
}

function isMissingFile(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT"
  );
}
