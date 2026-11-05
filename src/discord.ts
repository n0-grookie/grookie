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
  MessageReaction,
  NewsChannel,
  TextChannel,
  type AnyThreadChannel,
  type GuildMember,
  type PartialMessageReaction,
  type PartialUser,
  type ThreadAutoArchiveDuration,
  type ThreadChannel,
  type User,
} from "discord.js";

import type { Config } from "./config.js";
import {
  formatReplyPrefix,
  formatTimestamp,
  removeGrookieMention,
  type ContextMessage,
} from "./context.js";
import {
  isLeadReaction,
  leadPointer,
  leadSeedTurn,
  leadThreadName,
  type LeadIntakeConfig,
  type LeadSource,
} from "./leads.js";
import { GrookieAgent, type AgentEventHandler } from "./agent.js";
import { StateStore } from "./store.js";

const DISCORD_MESSAGE_LIMIT = 2_000;
const MESSAGE_WINDOW_MS = 10 * 60 * 1_000;
const MESSAGE_PAGE_SIZE = 100;

export class DiscordController {
  private readonly client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
      // Only needed for the lead-flag reaction; it is not a privileged intent, and
      // the event carries no message content, so the message is fetched by id.
      GatewayIntentBits.GuildMessageReactions,
    ],
  });
  private readonly processingMessageIds = new Set<string>();
  private readonly inaccessibleCatchUpChannels = new Set<string>();
  /**
   * Set once SIGTERM arrives. Catch-up is a long chain of REST calls, and every
   * in-flight one fails with "Expected token to be set" the moment the gateway
   * session is destroyed - without this flag a shutdown spews hundreds of those.
   */
  private closing = false;

  public constructor(
    private readonly config: Config,
    private readonly agent: GrookieAgent,
    private readonly store: StateStore,
  ) {}

  public async start(): Promise<void> {
    this.client.once(Events.ClientReady, (client) => {
      console.log(`Discord connected as ${client.user.tag}`);
      const lead = this.config.leadIntake;
      console.log(
        lead
          ? `Lead intake armed: ${lead.emoji} in channel ${lead.channelId}`
          : "Lead intake disabled (set GROOKIE_LEAD_CHANNEL_ID to arm it)",
      );
      void this.catchUp().catch((error: unknown) => {
        console.error("Failed to catch up recent Discord messages:", error);
      });
    });
    this.client.on(Events.MessageCreate, (message) => {
      void this.considerMessage(message).catch((error: unknown) => {
        console.error("Failed to handle Discord message:", error);
      });
    });
    this.client.on(Events.MessageReactionAdd, (reaction, user) => {
      void this.considerReaction(reaction, user).catch((error: unknown) => {
        console.error("Failed to handle Discord reaction:", error);
      });
    });
    await this.client.login(this.config.discordToken);
  }

  /**
   * Close the gateway session so SIGTERM does not leave the bot looking online.
   * Order matters: the flag goes up first, so the catch-up scan that is probably
   * still running stops issuing requests instead of erroring on a cleared token.
   */
  public async stop(): Promise<void> {
    this.closing = true;
    await this.client.destroy();
  }

  private async considerMessage(
    message: Message,
    cutoff = Date.now() - MESSAGE_WINDOW_MS,
    catchUp = false,
  ): Promise<void> {
    if (this.closing) return;
    if (!(await isCandidateMessage(message, this.client.user, cutoff))) return;
    if (
      this.processingMessageIds.has(message.id) ||
      this.store.hasProcessedMessage(message.id)
    ) {
      return;
    }

    this.processingMessageIds.add(message.id);
    try {
      if (!(await hasAllowedRole(message, this.config))) return;
      await this.respondToMessage(message, catchUp);
      this.store.markMessageProcessed(message.id, message.createdTimestamp);
      await this.store.save();
    } finally {
      this.processingMessageIds.delete(message.id);
    }
  }

  private async respondToMessage(
    message: Message,
    catchUp: boolean,
  ): Promise<void> {
    if (!this.client.user) throw new Error("Discord client is not ready");

    const thread = await this.ensureThread(message);
    const request = await toTurnMessage(message, this.client.user.id);

    if (!removeGrookieMention(message.content, this.client.user.id)) {
      await thread.send("What would you like me to help with?");
      return;
    }

    if (
      catchUp &&
      (await this.agent.hasPersistedRequest(thread.id, request))
    ) {
      console.log(
        `Skipping Discord message ${message.id}: already present in ${thread.id}`,
      );
      return;
    }

    await this.runTurn(thread, request);
  }

  /**
   * One Grookie turn, streamed into `thread`. Both entry points end here: a message
   * someone sent, and a lead-intake thread that only exists because of a reaction.
   */
  private async runTurn(
    thread: ThreadChannel,
    request: ContextMessage,
  ): Promise<void> {
    const turn = new DiscordTurn(thread);
    try {
      await this.agent.respond(thread.id, request, turn.handle, {
        leaveThread: async () => {
          await thread.leave();
          turn.markLeft();
        },
      });
      await turn.finish();
    } catch (error: unknown) {
      await thread.send(
        `I couldn't complete that response. Please try again.\nError: ${error}`,
      );
      throw error;
    }
  }

  /**
   * A 🤝 on a message means "this is a lead, write it down". The intake itself is a
   * normal Grookie turn in a thread - the interview needs judgement, not a form - so
   * this only decides where the thread goes and what it opens with.
   *
   * Reactions are not caught up on restart: unlike messages, a reaction we never saw
   * leaves no trace in the message window, so a reaction during downtime is dropped.
   */
  private async considerReaction(
    rawReaction: MessageReaction | PartialMessageReaction,
    reactor: User | PartialUser,
  ): Promise<void> {
    const config = this.config.leadIntake;
    if (this.closing || !config || !this.client.user) return;
    // Cheapest checks first: most reactions in the guild are not lead flags, and none
    // of these need a REST call - the emoji and the message id are on the partial.
    if (reactor.bot) return;
    if (!isLeadReaction(rawReaction.emoji.name, config)) return;
    const messageId = rawReaction.message.id;
    if (this.store.hasLeadIntake(messageId)) return;
    if (this.processingMessageIds.has(`lead:${messageId}`)) return;

    this.processingMessageIds.add(`lead:${messageId}`);
    try {
      // The gateway event carries no message content, so the flagged message is
      // fetched by id: the intake has to quote it.
      const message = await rawReaction.message.fetch();
      if (message.author.bot || message.guild === null) return;

      // Flagging a lead is a deliberate act, so it takes the same role the rest of
      // Grookie's triggers do. Otherwise anyone who can react could open threads in
      // #leads about any message they like.
      const member = await message.guild.members
        .fetch(reactor.id)
        .catch(() => null);
      if (!memberHasAllowedRole(member, this.config)) {
        console.log(
          `Ignoring lead-flag reaction on ${messageId} from ${reactor.id}: no allowed role`,
        );
        return;
      }

      await this.startLeadIntake(message, member.displayName, config);
    } finally {
      this.processingMessageIds.delete(`lead:${messageId}`);
    }
  }

  private async startLeadIntake(
    message: Message,
    reactorName: string,
    config: LeadIntakeConfig,
  ): Promise<void> {
    const source = leadSourceOf(message, reactorName);
    // Discord threads branch from a message in their own channel, so a flag raised
    // elsewhere is quoted into the leads channel first and threaded from the quote.
    const anchor = isInChannel(message, config.channelId)
      ? message
      : await this.postLeadPointer(source, config);
    const thread = await this.ensureThread(anchor, {
      name: leadThreadName(source),
      autoArchive: autoArchiveFor(anchor),
    });
    // Recorded before the turn runs: a thread that exists but whose first turn died is
    // still a thread, and re-reacting should not open a second one.
    this.store.markLeadIntake(message.id, thread.id);
    await this.store.save();
    // The turn has to carry its own context: a thread Grookie just opened starts blank,
    // with none of the channel it came from in it.
    await this.runTurn(thread, {
      id: `lead-intake:${message.id}`,
      authorId: this.client.user?.id ?? "0",
      authorName: "lead-intake",
      timestamp: formatTimestamp(Date.now()),
      content: leadSeedTurn(source, threadUrlOf(thread), config),
    });
    console.log(
      `Started lead intake for Discord message ${message.id} in thread ${thread.id}`,
    );
  }

  private async postLeadPointer(
    source: LeadSource,
    config: LeadIntakeConfig,
  ): Promise<Message> {
    const channel = await this.client.channels.fetch(config.channelId);
    // `isTextBased` alone still includes channel types that cannot be posted to.
    if (channel === null || !channel.isTextBased() || !("send" in channel)) {
      throw new Error(
        `Lead intake channel ${config.channelId} is not a channel Grookie can post in`,
      );
    }
    // Needs View Channel, Send Messages and Create Public Threads in that channel.
    return channel.send(leadPointer(source, config.emoji));
  }

  private async catchUp(): Promise<void> {
    const cutoff = Date.now() - MESSAGE_WINDOW_MS;
    this.inaccessibleCatchUpChannels.clear();
    this.store.pruneProcessedMessages(cutoff);
    await this.store.save();

    let guildCount = 0;
    for (const guild of this.client.guilds.cache.values()) {
      if (this.closing) break;
      guildCount += 1;
      await this.catchUpGuild(guild, cutoff);
    }
    if (this.closing) {
      console.log(`Discord catch-up scan interrupted by shutdown (${guildCount} guilds started)`);
      return;
    }
    console.log(`Discord catch-up scan complete (${guildCount} guilds)`);
    if (this.inaccessibleCatchUpChannels.size > 0) {
      console.warn(
        `Skipped ${this.inaccessibleCatchUpChannels.size} inaccessible Discord channels during catch-up`,
      );
    }
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
      if (this.closing) return;
      await this.scanChannel(channel, cutoff);
    }
    for (const parent of threadParents) {
      if (this.closing) return;
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
      if (isMissingAccessError(error)) {
        this.inaccessibleCatchUpChannels.add(channel.id);
        return;
      }
      if (this.closing) return;
      console.error(`Failed to fetch Discord channel ${channel.id}:`, error);
      return;
    }

    for (const message of messages) {
      try {
        await this.considerMessage(message, cutoff, true);
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
      while (!this.closing) {
        let page;
        try {
          page = await parent.threads.fetchArchived({
            type,
            limit: MESSAGE_PAGE_SIZE,
            ...(before ? { before } : {}),
          });
        } catch (error: unknown) {
          if (isMissingAccessError(error)) {
            this.inaccessibleCatchUpChannels.add(parent.id);
            return;
          }
          if (!this.closing) {
            console.error(
              `Failed to fetch ${type} archived threads for ${parent.id}:`,
              error,
            );
          }
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

  private async ensureThread(
    message: Message,
    options?: { name: string; autoArchive: ThreadAutoArchiveDuration },
  ): Promise<ThreadChannel> {
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
        if (!thread.members.me) await thread.join();
        return thread;
      }
    }

    if (message.channel.isThread()) {
      const thread = message.channel;
      if (message.channel.archived) {
        await message.channel.setArchived(
          false,
          "Respond to a recent Grookie mention",
        );
      }
      if (!thread.members.me) await thread.join();
      return thread;
    }
    if (!message.channel.isTextBased()) {
      throw new Error(
        "Grookie mentions must be sent in a text channel or thread",
      );
    }

    if (options) {
      return message.startThread({
        name: options.name.slice(0, 100),
        autoArchiveDuration: options.autoArchive,
        reason: "Lead intake for a flagged message",
      });
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

class DiscordTurn {
  private readonly typing: TypingHeartbeat;
  private assistantKey: string | undefined;
  private assistantText = "";
  private emittedAssistant = false;
  private left = false;

  public constructor(private readonly thread: ThreadChannel) {
    this.typing = new TypingHeartbeat(thread);
  }

  public readonly handle: AgentEventHandler = async (event) => {
    if (this.left) return;

    if (event.type === "assistant") {
      const key = event.otid ?? event.uuid;
      if (this.assistantKey !== undefined && this.assistantKey !== key) {
        await this.flushAssistant();
      }
      this.assistantKey = key;
      this.emittedAssistant = true;
      await this.typing.start();
      this.assistantText += event.content;
      return;
    }

    if (
      event.type === "reasoning" ||
      event.type === "tool_call" ||
      event.type === "tool_result" ||
      event.type === "result"
    ) {
      await this.flushAssistant();
      this.typing.stop();
    }

    if (event.type === "result" && !event.success) {
      throw new Error(event.errorDetail ?? event.error ?? "Letta turn failed");
    }

    if (event.type === "result" && !this.emittedAssistant && event.result) {
      await this.sendMessage(event.result);
    }
  };

  public async finish(): Promise<void> {
    await this.flushAssistant();
    this.typing.stop();
  }

  public markLeft(): void {
    this.left = true;
    this.typing.stop();
  }

  private async flushAssistant(): Promise<void> {
    if (!this.assistantText) return;
    const text = this.assistantText;
    this.assistantText = "";
    this.assistantKey = undefined;
    this.typing.stop();
    await this.sendMessage(text);
  }

  private async sendMessage(text: string): Promise<void> {
    for (const chunk of splitForDiscord(text)) {
      await this.thread.send(chunk);
    }
  }
}

class TypingHeartbeat {
  private timer: ReturnType<typeof setInterval> | undefined;
  private active = false;

  public constructor(private readonly thread: ThreadChannel) {}

  public async start(): Promise<void> {
    if (this.active) return;
    this.active = true;
    await this.thread.sendTyping();
    this.timer = setInterval(() => {
      void this.thread.sendTyping().catch((error: unknown) => {
        console.error(`Failed to refresh typing in thread ${this.thread.id}:`, error);
      });
    }, 5_000);
  }

  public stop(): void {
    if (!this.timer) {
      this.active = false;
      return;
    }
    clearInterval(this.timer);
    this.timer = undefined;
    this.active = false;
  }
}

function toContextMessage(message: Message): ContextMessage {
  return {
    id: message.id,
    authorId: message.author.id,
    authorName: message.member?.displayName ?? message.author.displayName,
    timestamp: formatTimestamp(message.createdTimestamp),
    content: message.content,
  };
}

async function toTurnMessage(
  message: Message,
  botId: string,
): Promise<ContextMessage> {
  const request = toContextMessage(message);
  const content = removeGrookieMention(message.content, botId);
  if (!content) return { ...request, content };

  const reference = message.reference?.messageId
    ? await message.fetchReference().catch(() => null)
    : null;
  if (!reference) return { ...request, content };

  const authorName =
    reference.member?.displayName ?? reference.author.displayName;
  const prefix = formatReplyPrefix(
    authorName,
    formatTimestamp(reference.createdTimestamp),
  );
  return { ...request, content: `${prefix}\n${content}` };
}

type HistoryChannel = TextChannel | NewsChannel | AnyThreadChannel;
type ThreadParent = TextChannel | NewsChannel | ForumChannel | MediaChannel;

async function isCandidateMessage(
  message: Message,
  clientUser: Client["user"],
  cutoff: number,
): Promise<boolean> {
  if (
    message.author.bot ||
    message.guild === null ||
    clientUser === null ||
    message.createdTimestamp < cutoff
  ) {
    return false;
  }
  if (message.mentions.users.has(clientUser.id)) return true;
  if (!message.channel.isThread()) return false;

  const member =
    message.channel.members.me ??
    (await message.channel.members.fetchMe().catch(() => null));
  return member !== null;
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

function isMissingAccessError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === 50001
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
  return memberHasAllowedRole(member, config);
}

function memberHasAllowedRole(
  member: GuildMember | null,
  config: Config,
): member is GuildMember {
  return (
    member !== null &&
    member.roles.cache.some((role) => config.allowedRoleIds.has(role.id))
  );
}

/**
 * Everything the intake thread needs to know about the flagged message. The reaction
 * event's message is complete once fetched, so this reads off the object rather than
 * going back to REST.
 */
function leadSourceOf(message: Message, reactorName: string): LeadSource {
  const channel = message.channel;
  // A thread's own name is not where a reader would look for the original, so the
  // seed names the channel it was branched from.
  const threadParent = channel.isThread() ? channel.parent : null;
  const channelName = threadParent
    ? threadParent.name
    : ("name" in channel ? channel.name : null) ?? channel.id;
  return {
    authorName: message.member?.displayName ?? message.author.displayName,
    timestamp: formatTimestamp(message.createdTimestamp),
    content: message.content,
    url: message.url,
    channelName,
    reactorNames: [reactorName],
    // Counted, not read: Grookie has no vision on this box, so the intake is told
    // there were attachments rather than being shown them.
    attachmentCount: message.attachments.size,
  };
}

/**
 * Whether the flagged message already lives in the leads channel - including when it
 * is a message inside a thread branched from it, which is the same conversation.
 */
function isInChannel(message: Message, channelId: string): boolean {
  return (
    message.channel.id === channelId ||
    (message.channel.isThread() && message.channel.parentId === channelId)
  );
}

/**
 * A lead intake waits on people who may not look at Discord for days, so it should not
 * archive on a day's silence. Rather than guess what the guild allows, use the channel's
 * own default - which is by definition allowed - and fall back to a day.
 */
function autoArchiveFor(message: Message): ThreadAutoArchiveDuration {
  const channel = message.channel;
  if (channel.isTextBased() && "defaultAutoArchiveDuration" in channel) {
    const configured = channel.defaultAutoArchiveDuration;
    if (configured !== null && configured !== undefined) return configured;
  }
  return 1440;
}

/** `ThreadChannel` has no `url` getter, so the jump link is assembled by hand. */
function threadUrlOf(thread: ThreadChannel): string {
  return `https://discord.com/channels/${thread.guildId}/${thread.id}`;
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
