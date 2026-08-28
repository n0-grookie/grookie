export interface ContextMessage {
  id: string;
  authorId: string;
  authorName: string;
  timestamp: string;
  content: string;
}

export function removeGrookieMention(content: string, botId: string): string {
  return content
    .replace(new RegExp(`<@!?${escapeRegExp(botId)}>`, "g"), "")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/[ \t]+\n/g, "\n")
    .trim();
}

export function formatTurn(request: ContextMessage): string {
  return formatMessage(request);
}

export function formatTimestamp(timestamp: number): string {
  return `${new Date(timestamp).toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

export function formatReplyPrefix(authorName: string, timestamp: string): string {
  return `(responding to ${authorName}'s message at ${timestamp})`;
}

function formatMessage(message: ContextMessage): string {
  return `[${message.timestamp}] ${message.authorName}: ${message.content}`;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
