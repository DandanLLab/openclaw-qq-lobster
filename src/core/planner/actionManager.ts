import type { ActionInfo, ActionPlannerInfo, ChatConfig, MessageInfo } from "../config.js";

export class ActionManager {
  private actions: Map<string, ActionInfo> = new Map();

  constructor() {
    this.registerDefaultActions();
  }

  private registerDefaultActions(): void {
    this.registerAction({
      name: "reply",
      description: "直接回复消息",
      actionParameters: {},
      actionRequire: [],
      parallelAction: false,
      activationType: "always",
    });

    this.registerAction({
      name: "no_reply",
      description: "不回复，保持沉默",
      actionParameters: {},
      actionRequire: [],
      parallelAction: false,
      activationType: "always",
    });

    this.registerAction({
      name: "send_new_message",
      description: "主动发送新消息",
      actionParameters: {
        message: "要发送的消息内容",
      },
      actionRequire: [],
      parallelAction: false,
      activationType: "never",
    });

    this.registerAction({
      name: "wait_time",
      description: "等待一段时间后再决定",
      actionParameters: {
        waitSeconds: "等待的秒数",
      },
      actionRequire: [],
      parallelAction: false,
      activationType: "never",
    });
  }

  registerAction(action: ActionInfo): void {
    this.actions.set(action.name, action);
  }

  getAction(name: string): ActionInfo | undefined {
    return this.actions.get(name);
  }

  getUsingActions(): Record<string, ActionInfo> {
    const result: Record<string, ActionInfo> = {};
    for (const [name, action] of this.actions) {
      if (action.activationType !== "never") {
        result[name] = action;
      }
    }
    return result;
  }

  getAllActions(): Record<string, ActionInfo> {
    return Object.fromEntries(this.actions);
  }
}
