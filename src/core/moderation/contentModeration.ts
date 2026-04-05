export interface ContentModerationResult {
  isViolation: boolean;
  violationType: "none" | "spam" | "abuse" | "advertising" | "politics" | "pornography" | "other";
  severity: "low" | "medium" | "high" | "critical";
  suggestedAction: "none" | "warn" | "mute" | "kick";
  suggestedMuteDuration: number;
  reason: string;
  confidence: number;
}

export interface ModerationConfig {
  enabled: boolean;
  autoMuteMaxDuration: number;
  requireAdminApprovalForKick: boolean;
  requireAdminApprovalForLongMute: boolean;
  longMuteThreshold: number;
  sensitiveWords: string[];
  exemptUsers: number[];
  exemptGroups: number[];
}

export interface AdminApprovalRequest {
  id: string;
  type: "mute" | "kick";
  targetUserId: number;
  targetUserName: string;
  groupId: number;
  groupName: string;
  reason: string;
  requestedBy: number;
  requestedByName: string;
  timestamp: number;
  duration?: number;
  status: "pending" | "approved" | "rejected";
  reviewedBy?: number;
  reviewedAt?: number;
}

export const DEFAULT_MODERATION_CONFIG: ModerationConfig = {
  enabled: true,
  autoMuteMaxDuration: 60,
  requireAdminApprovalForKick: true,
  requireAdminApprovalForLongMute: true,
  longMuteThreshold: 60,
  sensitiveWords: [],
  exemptUsers: [],
  exemptGroups: [],
};

const pendingApprovals = new Map<string, AdminApprovalRequest>();

export function createModerationPrompt(content: string, senderName: string, context?: string): string {
  return `你是一个宽松友好的社区内容审核助手。你的原则是：宁可漏过，不可误杀。

消息发送者: ${senderName}
消息内容: ${content}
${context ? `上下文: ${context}` : ""}

【重要原则】
1. 群聊是轻松的社交环境，朋友间开玩笑是正常的
2. 只有在【明确恶意】且【严重过分】的情况下才判定违规
3. 轻微的调侃、吐槽、开玩笑都属于正常社交，不要过度审核
4. 判断时要考虑语境，很多看似"攻击"的话其实是朋友间的玩笑
5. 只有以下情况才算违规：
   - 明显的恶意辱骂（不是朋友间互损）
   - 大量刷屏广告
   - 严重政治敏感内容
   - 明显的色情低俗内容
   - 真正的人身威胁

【宽松判定标准】
- 如果不确定是否违规，默认判定为【不违规】
- confidence 低于 0.8 时，不判定为违规
- severity 只有在极端情况下才设为 high 或 critical
- 朋友间的互损、吐槽、开玩笑统统不算违规
- 带有幽默语气的"攻击"不算违规

请判断:
1. 是否违规 (要非常确定才算违规)
2. 违规类型 (无/垃圾广告/辱骂攻击/政治敏感/色情低俗/其他)
3. 严重程度 (低/中/高/严重) - 大多数情况应该是低
4. 建议处理方式 (无/警告/禁言/踢出) - 大多数情况应该是无
5. 如果建议禁言，建议禁言时长(秒)

请以JSON格式回复:
{
  "isViolation": true/false,
  "violationType": "none/spam/abuse/politics/pornography/other",
  "severity": "low/medium/high/critical",
  "suggestedAction": "none/warn/mute/kick",
  "suggestedMuteDuration": 数字(秒),
  "reason": "原因说明",
  "confidence": 0.0-1.0
}`;
}

export function parseModerationResponse(response: string): ContentModerationResult {
  try {
    const jsonMatch = response.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      return createDefaultResult();
    }
    
    const parsed = JSON.parse(jsonMatch[0]);
    
    return {
      isViolation: parsed.isViolation ?? false,
      violationType: parsed.violationType ?? "none",
      severity: parsed.severity ?? "low",
      suggestedAction: parsed.suggestedAction ?? "none",
      suggestedMuteDuration: Math.min(parsed.suggestedMuteDuration ?? 60, 300),
      reason: parsed.reason ?? "",
      confidence: parsed.confidence ?? 0.5,
    };
  } catch {
    return createDefaultResult();
  }
}

function createDefaultResult(): ContentModerationResult {
  return {
    isViolation: false,
    violationType: "none",
    severity: "low",
    suggestedAction: "none",
    suggestedMuteDuration: 0,
    reason: "无法解析审核结果",
    confidence: 0,
  };
}

export function shouldAutoMute(result: ContentModerationResult, config: ModerationConfig): boolean {
  if (!config.enabled) return false;
  if (result.suggestedAction !== "mute") return false;
  if (result.suggestedMuteDuration > config.autoMuteMaxDuration) return false;
  if (result.confidence < 0.85) return false;
  if (result.severity === "low") return false;
  return true;
}

export function needsAdminApproval(
  result: ContentModerationResult,
  config: ModerationConfig
): { needsApproval: boolean; reason: string } {
  if (!config.enabled) {
    return { needsApproval: false, reason: "" };
  }
  
  if (result.suggestedAction === "kick" && config.requireAdminApprovalForKick) {
    if (result.confidence < 0.9) {
      return { needsApproval: true, reason: "踢人操作需要管理员审核（置信度不足）" };
    }
    return { needsApproval: true, reason: "踢人操作需要管理员审核" };
  }
  
  if (result.suggestedAction === "mute") {
    if (result.suggestedMuteDuration <= 60) {
      return { needsApproval: false, reason: "" };
    }
    
    if (result.suggestedMuteDuration > config.longMuteThreshold &&
        config.requireAdminApprovalForLongMute) {
      return { needsApproval: true, reason: `禁言时长超过${config.longMuteThreshold}秒，需要管理员审核` };
    }
  }
  
  return { needsApproval: false, reason: "" };
}

export function createApprovalRequest(
  type: "mute" | "kick",
  targetUserId: number,
  targetUserName: string,
  groupId: number,
  groupName: string,
  reason: string,
  requestedBy: number,
  requestedByName: string,
  duration?: number
): AdminApprovalRequest {
  const id = `approval_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  
  const request: AdminApprovalRequest = {
    id,
    type,
    targetUserId,
    targetUserName,
    groupId,
    groupName,
    reason,
    requestedBy,
    requestedByName,
    timestamp: Date.now(),
    duration,
    status: "pending",
  };
  
  pendingApprovals.set(id, request);
  return request;
}

export function getPendingApprovals(groupId?: number): AdminApprovalRequest[] {
  const approvals = Array.from(pendingApprovals.values()).filter(a => a.status === "pending");
  if (groupId) {
    return approvals.filter(a => a.groupId === groupId);
  }
  return approvals;
}

export function getApprovalRequest(id: string): AdminApprovalRequest | undefined {
  return pendingApprovals.get(id);
}

export function approveRequest(id: string, reviewedBy: number): AdminApprovalRequest | undefined {
  const request = pendingApprovals.get(id);
  if (request && request.status === "pending") {
    request.status = "approved";
    request.reviewedBy = reviewedBy;
    request.reviewedAt = Date.now();
    return request;
  }
  return undefined;
}

export function rejectRequest(id: string, reviewedBy: number): AdminApprovalRequest | undefined {
  const request = pendingApprovals.get(id);
  if (request && request.status === "pending") {
    request.status = "rejected";
    request.reviewedBy = reviewedBy;
    request.reviewedAt = Date.now();
    return request;
  }
  return undefined;
}

export function cleanupOldApprovals(maxAge: number = 3600000): void {
  const now = Date.now();
  for (const [id, request] of pendingApprovals) {
    if (now - request.timestamp > maxAge) {
      pendingApprovals.delete(id);
    }
  }
}

export function formatApprovalNotification(request: AdminApprovalRequest): string {
  const actionText = request.type === "kick" ? "踢出" : `禁言 ${request.duration}秒`;
  return `【审核请求】
群号: ${request.groupId}
操作: ${actionText}
目标: ${request.targetUserName} (${request.targetUserId})
原因: ${request.reason}

请在该群聊中执行:
/pending - 查看待审核
/同意 ${request.id.slice(-8)} - 同意
/拒绝 ${request.id.slice(-8)} - 拒绝`;
}
