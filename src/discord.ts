import {
  Client,
  Events,
  GatewayIntentBits,
  SnowflakeUtil,
  ForumChannel,
  type GuildBasedChannel,
  type Guild,
  type Message,
  MediaChannel,
  NewsChannel,
  TextChannel,
  type AnyThreadChannel,
  type ThreadChannel,
} from "discord.js";

import type { Config } from "./config.js";
import {
  limitContext,
  removeGrookieMention,
  type ContextMessage,
} from "./context.js";
import { GrookieAgent } from "./agent.js";
import { StateStore } from "./store.js";

const DISCORD_MESSAGE_LIMIT = 2_000;
const MESSAGE_WINDOW_MS = 30 * 60 * 1_000;
const MESSAGE_PAGE_SIZE = 100;

export class DiscordController {
  private readonly client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
    ],
  });
  private readonly processingMessageIds = new Set<string>();

  public constructor(
    private readonly config: Config,
    private readonly agent: GrookieAgent,
    private readonly store: StateStore,
  ) {}

  public async start(): Promise<void> {
    this.client.once(Events.ClientReady, (client) => {
      console.log(`Discord connected as ${client.user.tag}`);
      void this.catchUp().catch((error: unknown) => {
        console.error("Failed to catch up recent Discord messages:", error);
      });
    });
    this.client.on(Events.MessageCreate, (message) => {
      void this.considerMessage(message).catch((error: unknown) => {
        console.error("Failed to handle Discord message:", error);
      });
    });
    await this.client.login(this.config.discordToken);
  }

  private async considerMessage(
    message: Message,
    cutoff = Date.now() - MESSAGE_WINDOW_MS,
  ): Promise<void> {
    if (!isCandidateMessage(message, this.client.user, cutoff)) return;
    if (
      this.processingMessageIds.has(message.id) ||
      this.store.hasProcessedMessage(message.id)
    ) {
      return;
    }

    this.processingMessageIds.add(message.id);
    try {
      if (!(await hasAllowedRole(message, this.config))) return;
      await this.respondToMessage(message);
      this.store.markMessageProcessed(message.id, message.createdTimestamp);
      await this.store.save();
    } finally {
      this.processingMessageIds.delete(message.id);
    }
  }

  private async respondToMessage(message: Message): Promise<void> {
    if (!this.client.user) throw new Error("Discord client is not ready");

    const thread = await this.ensureThread(message);
    const recentMessages = await thread.messages.fetch({
      limit: this.config.contextMessageLimit,
    });
    const context = limitContext(
      [...recentMessages.values()]
        .sort((left, right) => left.createdTimestamp - right.createdTimestamp)
        .map(toContextMessage),
      this.config.contextMessageLimit,
      this.config.contextCharacterLimit,
    );
    const request = {
      ...toContextMessage(message),
      content: removeGrookieMention(message.content, this.client.user.id),
    };

    if (!request.content) {
      await thread.send("What would you like me to help with?");
      return;
    }

    await thread.sendTyping();
    try {
      const response = await this.agent.respond(thread.id, context, request);
      for (const chunk of splitForDiscord(response)) {
        await thread.send(chunk);
      }
    } catch (error: unknown) {
      await thread.send(
        `I couldn't complete that response. Please try again.\nError: ${error}`,
      );
      throw error;
    }
  }

  private async catchUp(): Promise<void> {
    const cutoff = Date.now() - MESSAGE_WINDOW_MS;
    this.store.pruneProcessedMessages(cutoff);
    await this.store.save();

    let guildCount = 0;
    for (const guild of this.client.guilds.cache.values()) {
      guildCount += 1;
      await this.catchUpGuild(guild, cutoff);
    }
    console.log(`Discord catch-up scan complete (${guildCount} guilds)`);
  }

  private async catchUpGuild(guild: Guild, cutoff: number): Promise<void> {
    const channels = await guild.channels.fetch();
    const messageChannels = new Map<string, HistoryChannel>();
    const threadParents: ThreadParent[] = [];

    for (const channel of channels.values()) {
      if (!channel) continue;
      if (isHistoryChannel(channel) && !channel.isThread()) {
        messageChannels.set(channel.id, channel);
      }
      if (isThreadParent(channel)) threadParents.push(channel);
    }

    const activeThreads = await guild.channels.fetchActiveThreads();
    for (const thread of activeThreads.threads.values()) {
      if (isHistoryChannel(thread)) messageChannels.set(thread.id, thread);
    }

    for (const channel of messageChannels.values()) {
      await this.scanChannel(channel, cutoff);
    }
    for (const parent of threadParents) {
      await this.scanArchivedThreads(parent, cutoff);
    }
  }

  private async scanChannel(
    channel: HistoryChannel,
    cutoff: number,
  ): Promise<void> {
    let messages: Message[];
    try {
      messages = await fetchRecentMessages(channel, cutoff);
    } catch (error: unknown) {
      console.error(`Failed to fetch Discord channel ${channel.id}:`, error);
      return;
    }

    for (const message of messages) {
      try {
        await this.considerMessage(message, cutoff);
      } catch (error: unknown) {
        console.error(
          `Failed to process Discord message ${message.id}:`,
          error,
        );
      }
    }
  }

  private async scanArchivedThreads(
    parent: ThreadParent,
    cutoff: number,
  ): Promise<void> {
    for (const type of ["public", "private"] as const) {
      let before: Date | undefined;
      while (true) {
        let page;
        try {
          page = await parent.threads.fetchArchived({
            type,
            limit: MESSAGE_PAGE_SIZE,
            ...(before ? { before } : {}),
          });
        } catch (error: unknown) {
          console.error(
            `Failed to fetch ${type} archived threads for ${parent.id}:`,
            error,
          );
          break;
        }

        const threads = [...page.threads.values()];
        if (threads.length === 0) break;
        for (const thread of threads) {
          if (isHistoryChannel(thread)) await this.scanChannel(thread, cutoff);
        }

        const archiveTimes = threads
          .map((thread) => thread.archiveTimestamp)
          .filter((timestamp): timestamp is number => timestamp !== null);
        const oldest = Math.min(...archiveTimes);
        if (!page.hasMore || !Number.isFinite(oldest) || oldest < cutoff) break;
        before = new Date(oldest - 1);
      }
    }
  }

  private async ensureThread(message: Message): Promise<ThreadChannel> {
    if (message.hasThread) {
      const thread =
        message.thread ??
        ("threads" in message.channel
          ? await message.channel.threads.fetch(message.id).catch(() => null)
          : null);
      if (thread) {
        if (thread.archived) {
          await thread.setArchived(false);
        }
        return thread;
      }
    }

    if (message.channel.isThread()) {
      if (message.channel.archived) {
        await message.channel.setArchived(
          false,
          "Respond to a recent Grookie mention",
        );
      }
      return message.channel;
    }
    if (!message.channel.isTextBased()) {
      throw new Error(
        "Grookie mentions must be sent in a text channel or thread",
      );
    }

    const title = removeGrookieMention(
      message.content,
      this.client.user?.id ?? "",
    ).replace(/\s+/g, " ");
    return message.startThread({
      name: `Grookie: ${title || "request"}`.slice(0, 100),
      autoArchiveDuration: 1440,
      reason: "Create a conversation thread for Grookie",
    });
  }
}

function toContextMessage(message: Message): ContextMessage {
  return {
    id: message.id,
    authorId: message.author.id,
    authorName: message.member?.displayName ?? message.author.displayName,
    timestamp: new Date(message.createdTimestamp).toISOString(),
    content: message.content,
  };
}

type HistoryChannel = TextChannel | NewsChannel | AnyThreadChannel;
type ThreadParent = TextChannel | NewsChannel | ForumChannel | MediaChannel;

function isCandidateMessage(
  message: Message,
  clientUser: Client["user"],
  cutoff: number,
): boolean {
  return (
    message.author.bot === false &&
    message.guild !== null &&
    clientUser !== null &&
    message.createdTimestamp >= cutoff &&
    message.mentions.users.has(clientUser.id)
  );
}

function isHistoryChannel(
  channel: GuildBasedChannel | null,
): channel is HistoryChannel {
  return Boolean(channel?.isTextBased() && "messages" in channel);
}

function isThreadParent(channel: GuildBasedChannel): channel is ThreadParent {
  return (
    channel instanceof TextChannel ||
    channel instanceof NewsChannel ||
    channel instanceof ForumChannel ||
    channel instanceof MediaChannel
  );
}

async function hasAllowedRole(
  message: Message,
  config: Config,
): Promise<boolean> {
  if (!message.guild) return false;
  const member =
    message.member ??
    (await message.guild.members.fetch(message.author.id).catch(() => null));
  return (
    member !== null &&
    member.roles.cache.some((role) => config.allowedRoleIds.has(role.id))
  );
}

async function fetchRecentMessages(
  channel: HistoryChannel,
  cutoff: number,
): Promise<Message[]> {
  const messages = new Map<string, Message>();
  let after = SnowflakeUtil.generate({ timestamp: cutoff }).toString();

  while (true) {
    const page = await channel.messages.fetch({
      after,
      limit: MESSAGE_PAGE_SIZE,
      cache: false,
    });
    if (page.size === 0) break;

    for (const message of page.values()) {
      if (message.createdTimestamp >= cutoff) messages.set(message.id, message);
    }

    const newest = [...page.values()].reduce<Message | undefined>(
      (current, message) =>
        !current || message.createdTimestamp > current.createdTimestamp
          ? message
          : current,
      undefined,
    );
    if (page.size < MESSAGE_PAGE_SIZE || !newest || newest.id === after) {
      break;
    }
    after = newest.id;
  }

  return [...messages.values()].sort(
    (left, right) => left.createdTimestamp - right.createdTimestamp,
  );
}

function splitForDiscord(text: string): string[] {
  const chunks: string[] = [];
  for (let offset = 0; offset < text.length; offset += DISCORD_MESSAGE_LIMIT) {
    chunks.push(text.slice(offset, offset + DISCORD_MESSAGE_LIMIT));
  }
  return chunks;
}
