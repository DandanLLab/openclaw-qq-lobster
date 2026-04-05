import type { GoalInfo, ActionHistory } from "./actionPlanner.js";

export interface ConversationInfo {
  goalList: GoalInfo[];
  doneAction: ActionHistory[];
  knowledgeList: KnowledgeItem[];
}

export interface KnowledgeItem {
  query: string;
  knowledge: string;
  source: string;
}

export function createConversationInfo(): ConversationInfo {
  return {
    goalList: [],
    doneAction: [],
    knowledgeList: [],
  };
}

export function addGoal(info: ConversationInfo, goal: GoalInfo): void {
  info.goalList.unshift(goal);
  if (info.goalList.length > 3) {
    info.goalList.pop();
  }
}

export function addDoneAction(info: ConversationInfo, action: ActionHistory): void {
  info.doneAction.push(action);
  if (info.doneAction.length > 20) {
    info.doneAction = info.doneAction.slice(-10);
  }
}

export function addKnowledge(info: ConversationInfo, item: KnowledgeItem): void {
  info.knowledgeList.push(item);
  if (info.knowledgeList.length > 10) {
    info.knowledgeList = info.knowledgeList.slice(-5);
  }
}
