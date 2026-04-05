export interface EmotionResult {
  emotion: string;
  intensity: number;
  keywords: string[];
}

const EMOTION_KEYWORDS: Record<string, string[]> = {
  happy: ["开心", "高兴", "快乐", "哈哈", "嘻嘻", "好的", "太好了", "棒", "赞", "喜欢", "爱", "可爱", "有趣", "有趣", "谢谢", "感谢", "太棒了", "厉害", "牛逼", "666", "好耶", "nice", "good", "great", "😊", "😄", "🎉", "✨"],
  sad: ["难过", "伤心", "悲伤", "哭", "泪", "遗憾", "可惜", "心痛", "难受", "郁闷", "不开心", "失落", "沮丧", "😢", "😭", "💔"],
  angry: ["生气", "愤怒", "火大", "烦", "讨厌", "恶心", "气死", "可恶", "混蛋", "傻逼", "妈的", "草", "操", "怒", "😡", "😠", "💢"],
  surprised: ["惊讶", "震惊", "意外", "没想到", "天哪", "卧槽", "我靠", "什么", "真的假的", "不会吧", "啊这", "??", "？?", "😱", "😲", "🤯"],
  confused: ["困惑", "迷茫", "不懂", "不明白", "什么意思", "怎么", "为什么", "咋", "咋回事", "？", "?", "🤔", "😅"],
  worried: ["担心", "焦虑", "紧张", "害怕", "恐惧", "不安", "忧虑", "着急", "慌", "😰", "😟"],
  love: ["爱", "喜欢", "心动", "想念", "思念", "亲爱", "宝贝", "老婆", "老公", "么么哒", "亲亲", "抱抱", "❤️", "💕", "💖", "💗"],
  tired: ["累", "困", "疲惫", "无力", "没劲", "想睡", "好累", "心累", "😴", "😪"],
  excited: ["兴奋", "激动", "期待", "迫不及待", "等不及", "太期待了", "好激动", "🤩", "🥳"],
};

const EMOTION_EMOJI_MAP: Record<string, string[]> = {
  happy: ["😊", "😄", "🎉", "✨", "👍", "💪"],
  sad: ["😢", "😭", "💔", "🥺"],
  angry: ["😤", "💢", "👊"],
  surprised: ["😲", "😱", "🤯"],
  confused: ["🤔", "😅", "😂"],
  worried: ["😰", "😟", "🥺"],
  love: ["❤️", "💕", "💖", "💗", "🥰"],
  tired: ["😴", "😪", "🥱"],
  excited: ["🤩", "🥳", "🎊", "✨"],
};

export function analyzeEmotion(text: string): EmotionResult {
  const scores: Record<string, number> = {};
  const matchedKeywords: string[] = [];

  for (const [emotion, keywords] of Object.entries(EMOTION_KEYWORDS)) {
    let score = 0;
    for (const keyword of keywords) {
      if (text.includes(keyword)) {
        score += keyword.length;
        matchedKeywords.push(keyword);
      }
    }
    scores[emotion] = score;
  }

  let maxEmotion = "neutral";
  let maxScore = 0;

  for (const [emotion, score] of Object.entries(scores)) {
    if (score > maxScore) {
      maxScore = score;
      maxEmotion = emotion;
    }
  }

  const intensity = Math.min(maxScore / 10, 1);

  return {
    emotion: maxEmotion,
    intensity,
    keywords: [...new Set(matchedKeywords)],
  };
}

export function getEmojiForEmotion(emotion: string): string {
  const emojis = EMOTION_EMOJI_MAP[emotion];
  if (!emojis || emojis.length === 0) {
    return "😊";
  }
  return emojis[Math.floor(Math.random() * emojis.length)];
}

export function addEmotionToText(text: string, emotion: string): string {
  if (emotion === "neutral") return text;
  
  const emoji = getEmojiForEmotion(emotion);
  
  if (text.endsWith("。") || text.endsWith("！") || text.endsWith("？") || text.endsWith(".")) {
    return text.slice(0, -1) + emoji;
  }
  
  if (!/[！？。.,!?]$/.test(text)) {
    return text + emoji;
  }
  
  return text + emoji;
}

export function detectTone(text: string): "formal" | "casual" | "playful" | "serious" {
  const playfulPatterns = /[~～啊呀吧呢嘛]+$/;
  const formalPatterns = /[。！？]$/;
  const seriousPatterns = /(请|务必|重要|紧急|注意)/;

  if (playfulPatterns.test(text)) return "playful";
  if (seriousPatterns.test(text)) return "serious";
  if (formalPatterns.test(text)) return "formal";
  
  return "casual";
}

export function adjustReplyStyle(
  reply: string, 
  emotion: EmotionResult,
  tone: "formal" | "casual" | "playful" | "serious" = "casual"
): string {
  if (emotion.intensity > 0.5 && emotion.emotion !== "neutral") {
    const emoji = getEmojiForEmotion(emotion.emotion);
    if (!reply.includes(emoji)) {
      return addEmotionToText(reply, emotion.emotion);
    }
  }
  
  return reply;
}

export function getReplyStyleSuggestion(emotion: EmotionResult): string {
  const styleMap: Record<string, string> = {
    happy: "积极、热情、分享快乐",
    sad: "温柔、安慰、理解",
    angry: "冷静、客观、避免冲突",
    surprised: "惊讶、好奇、关注",
    confused: "耐心、解释、引导",
    worried: "安抚、支持、鼓励",
    love: "温暖、亲密、回应感情",
    tired: "理解、轻松、不强迫",
    excited: "热情、参与、共鸣",
    neutral: "自然、友好、简洁",
  };
  
  return styleMap[emotion.emotion] || styleMap.neutral;
}
