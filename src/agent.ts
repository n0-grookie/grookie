import {
  LettaAgentClient,
  type AnyAgentTool,
  type LettaCodeSession,
  type SDKMessage,
} from "@letta-ai/letta-agent-sdk";

import type { Config } from "./config.js";
import { formatTurn, type ContextMessage } from "./context.js";
import { StateStore } from "./store.js";

const PERSONA = [
  "You are Grookie, a calm and useful company companion in Discord.",
  "You answer messages sent to you in Discord threads.",
  "Use the available tools when they help answer the user or complete a task.",
  "Do not claim to have performed an action or checked a source when you could not do so.",
  "Keep answers suitable for a shared company Discord thread: concise, clear, and considerate.",
].join("\n");

const AGENT_PROMPT_VERSION = 2;

export type AgentEventHandler = (event: SDKMessage) => void | Promise<void>;

export interface AgentActions {
  leaveThread: () => Promise<void>;
}

export class GrookieAgent {
  private readonly client: LettaAgentClient;
  private readonly sessions = new Map<string, Promise<ThreadSession>>();
  private agentId: string | undefined;

  public constructor(
    private readonly config: Config,
    private readonly store: StateStore,
  ) {
    this.client = new LettaAgentClient({ backend: "local" });
  }

  public async initialize(): Promise<void> {
    this.agentId = this.store.agentId;
    if (
      !this.agentId ||
      this.store.agentPromptVersion !== AGENT_PROMPT_VERSION
    ) {
      const agentId = await this.client.createAgent({
        name: "Grookie",
        description: "A local company companion for Discord.",
        persona: PERSONA,
        baseTools: [],
        permissionMode: "unrestricted",
        ...(this.config.model ? { model: this.config.model } : {}),
      });
      if (this.agentId) this.store.resetConversations();
      this.agentId = agentId;
      this.store.setAgentId(agentId);
      this.store.setAgentPromptVersion(AGENT_PROMPT_VERSION);
      await this.store.save();
      return;
    }
  }

  public async respond(
    threadId: string,
    request: ContextMessage,
    onEvent: AgentEventHandler,
    actions: AgentActions,
  ): Promise<void> {
    const session = this.getSession(threadId);
    return (await session).enqueue(request, onEvent, actions);
  }

  private getSession(threadId: string): Promise<ThreadSession> {
    const existing = this.sessions.get(threadId);
    if (existing) return existing;

    const session = this.createSession(threadId);
    this.sessions.set(threadId, session);
    void session.then(
      (threadSession) =>
        threadSession.setOnClosed(() => {
          if (this.sessions.get(threadId) === session) this.sessions.delete(threadId);
        }),
      () => {
        if (this.sessions.get(threadId) === session) this.sessions.delete(threadId);
      },
    );
    return session;
  }

  private async createSession(threadId: string): Promise<ThreadSession> {
    if (!this.agentId) throw new Error("Grookie agent is not initialized");

    let conversationId = this.store.conversationId(threadId);
    let threadSession: ThreadSession | undefined;
    const sessionOptions = {
      toolset: { base: "default" as const },
      permissionMode: "unrestricted" as const,
      tools: [
        createLeaveThreadTool(async () => {
          if (!threadSession) throw new Error("Thread session is not ready");
          await threadSession.leaveCurrentThread();
        }),
      ],
    };

    const session = conversationId
      ? this.client.resumeSession(conversationId, sessionOptions)
      : this.client.createSession(this.agentId, sessionOptions);
    try {
      if (!conversationId) {
        conversationId = (await session.bootstrapState()).conversationId;
      }
      this.store.setConversationId(threadId, conversationId);
      await this.store.save();
      threadSession = new ThreadSession(session);
      return threadSession;
    } catch (error) {
      session.close();
      throw error;
    }
  }
}

function createLeaveThreadTool(leaveThread: () => Promise<void>): AnyAgentTool {
  return {
    label: "Leave Discord thread",
    name: "leave_discord_thread",
    description:
      "Leave the current Discord thread when the conversation should no longer receive automatic replies. Do not use this to finish an ordinary response.",
    parameters: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    execute: async () => {
      try {
        await leaveThread();
        return {
          content: [
            { type: "text", text: "You left the current Discord thread." },
          ],
        };
      } catch (error: unknown) {
        return {
          content: [
            {
              type: "text",
              text: `Could not leave the Discord thread: ${error}`,
            },
          ],
          isError: true,
        };
      }
    },
  };
}

interface PendingTurn {
  request: ContextMessage;
  onEvent: AgentEventHandler;
  actions: AgentActions;
  resolve: () => void;
  reject: (error: unknown) => void;
}

class ThreadSession {
  private readonly pending: PendingTurn[] = [];
  private current: PendingTurn | undefined;
  private consuming: Promise<void> | undefined;
  private sending: Promise<void> = Promise.resolve();
  private closed = false;
  private onClosed: (() => void) | undefined;

  public constructor(private readonly session: LettaCodeSession) {}

  public async enqueue(
    request: ContextMessage,
    onEvent: AgentEventHandler,
    actions: AgentActions,
  ): Promise<void> {
    if (this.closed) throw new Error("Letta session is unavailable");

    let pendingTurn: PendingTurn | undefined;
    const turn = new Promise<void>((resolve, reject) => {
      pendingTurn = { request, onEvent, actions, resolve, reject };
      this.pending.push(pendingTurn);
    });

    const send = this.sending.then(() =>
      this.session.send(formatTurn(request), { otid: request.id }),
    );
    this.sending = send.catch(() => undefined);
    try {
      await send;
    } catch (error) {
      const index = this.pending.findIndex(
        (pending) => pending === pendingTurn,
      );
      if (index >= 0) this.pending.splice(index, 1);
      pendingTurn?.reject(error);
      throw error;
    }

    if (!this.consuming) {
      this.consuming = this.consume();
    }
    return turn;
  }

  public setOnClosed(onClosed: () => void): void {
    this.onClosed = onClosed;
  }

  public async leaveCurrentThread(): Promise<void> {
    if (!this.current) throw new Error("No Discord turn is active");
    await this.current.actions.leaveThread();
  }

  private async consume(): Promise<void> {
    try {
      while (true) {
        let received = false;
        for await (const event of this.session.stream()) {
          received = true;
          if (event.type === "init") continue;
          this.current ??= this.pending.shift();
          if (!this.current) continue;

          const current = this.current;
          await current.onEvent(event);
          if (event.type === "result") {
            if (event.success) {
              current.resolve();
            } else {
              current.reject(
                new Error(event.errorDetail ?? event.error ?? "Letta turn failed"),
              );
            }
            this.current = undefined;
          }
        }
        if (!received) throw new Error("Letta session stream closed");
      }
    } catch (error) {
      this.closed = true;
      this.current?.reject(error);
      for (const pending of this.pending.splice(0)) pending.reject(error);
      this.current = undefined;
      this.session.close();
      this.onClosed?.();
    } finally {
      this.consuming = undefined;
    }
  }
}
