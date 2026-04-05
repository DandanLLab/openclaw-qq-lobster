import type { MessageInfo } from "../../config.js";

export interface ObservationInfo {
  chatHistory: MessageInfo[];
  chatHistoryStr: string;
  newMessagesCount: number;
  unprocessedMessages: MessageInfo[];
}

export function createObservationInfo(
  chatHistory: MessageInfo[],
  unprocessedMessages: MessageInfo[]
): ObservationInfo {
  const chatHistoryStr = buildChatHistoryStr(chatHistory);
  return {
    chatHistory,
    chatHistoryStr,
    newMessagesCount: unprocessedMessages.length,
    unprocessedMessages,
  };
}

function buildChatHistoryStr(messages: MessageInfo[]): string {
  if (messages.length === 0) return "还没有聊天记录。";
  
  return messages.slice(-10).map(m => {
    const time = new Date(m.timestamp).toLocaleTimeString();
    const source = m.isGroup ? `[群聊]` : `[私聊]`;
    return `${time} ${source} ${m.userName}: ${m.content}`;
  }).join("\n");
}
