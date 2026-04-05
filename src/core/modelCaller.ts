export interface ModelConfig {
  model: string;
  provider: string;
  weight?: number;
}

export interface ProviderConfig {
  baseUrl?: string;
  baseURL?: string;
  apiKey?: string;
  api?: string;
}

export interface ModelCallOptions {
  messages: Array<{ role: string; content: string | any[] }>;
  maxTokens?: number;
  temperature?: number;
  timeout?: number;
}

export interface ModelCallResult {
  success: boolean;
  content?: string;
  error?: string;
  model?: string;
  provider?: string;
}

export interface ModelTaskConfig {
  models: ModelConfig[];
  maxTokens?: number;
  temperature?: number;
  selectionStrategy?: "balance" | "priority" | "random";
  description?: string;
}

export function getModelTaskConfig(cfg: any, taskName: string): ModelTaskConfig | null {
  try {
    const modelTasks = cfg?.modelTasks || cfg?.channels?.qq?.modelTasks || cfg?.qq?.modelTasks || cfg?.modelRotation?.tasks;
    if (!modelTasks) return null;
    return modelTasks[taskName] || null;
  } catch {
    return null;
  }
}

export function getProviders(cfg: any): Record<string, ProviderConfig> {
  return cfg?.providers || cfg?.models?.providers || {};
}

export async function callWithModelRotation(
  providers: Record<string, ProviderConfig>,
  taskConfig: ModelTaskConfig,
  options: ModelCallOptions
): Promise<ModelCallResult> {
  if (!taskConfig || !taskConfig.models || taskConfig.models.length === 0) {
    return { success: false, error: "没有可用的模型配置" };
  }

  const models = [...taskConfig.models].sort((a, b) => (b.weight || 0) - (a.weight || 0));

  let lastError: string = "";

  for (const modelConfig of models) {
    const provider = providers[modelConfig.provider];
    if (!provider) {
      lastError = `Provider ${modelConfig.provider} 不存在`;
      continue;
    }

    try {
      const baseUrl = provider.baseUrl || provider.baseURL || "";
      const apiKey = provider.apiKey || "";
      const api = provider.api || "openai";

      const result = await callModel(baseUrl, apiKey, api, modelConfig.model, options);
      
      if (result.success) {
        return {
          success: true,
          content: result.content,
          model: modelConfig.model,
          provider: modelConfig.provider,
        };
      }
      
      lastError = result.error || "调用失败";
    } catch (e) {
      lastError = String(e);
    }
  }

  return { success: false, error: lastError };
}

async function callModel(
  baseUrl: string,
  apiKey: string,
  api: string,
  model: string,
  options: ModelCallOptions
): Promise<{ success: boolean; content?: string; error?: string }> {
  const url = baseUrl.endsWith("/") ? baseUrl + "chat/completions" : baseUrl + "/chat/completions";
  
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };

  if (apiKey) {
    headers["Authorization"] = `Bearer ${apiKey}`;
  }

  const body = {
    model,
    messages: options.messages,
    max_tokens: options.maxTokens || 1024,
    temperature: options.temperature || 0.7,
  };

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeout || 30000);

  try {
    const response = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    clearTimeout(timeout);

    if (!response.ok) {
      const errorText = await response.text();
      return { success: false, error: `HTTP ${response.status}: ${errorText}` };
    }

    const data = await response.json();
    const content = data.choices?.[0]?.message?.content || "";
    
    return { success: true, content };
  } catch (e) {
    clearTimeout(timeout);
    if ((e as Error).name === "AbortError") {
      return { success: false, error: `超时 (${options.timeout || 30000}ms)` };
    }
    return { success: false, error: String(e) };
  }
}

export interface VLCallOptions {
  prompt: string;
  imageBase64: string;
  imageFormat: string;
  maxTokens?: number;
  temperature?: number;
  timeout?: number;
}

export async function callVLMWithModelRotation(
  providers: Record<string, ProviderConfig>,
  taskConfig: ModelTaskConfig,
  options: VLCallOptions
): Promise<ModelCallResult> {
  if (!taskConfig || !taskConfig.models || taskConfig.models.length === 0) {
    return { success: false, error: "没有可用的VLM模型配置" };
  }

  const models = [...taskConfig.models].sort((a, b) => (b.weight || 0) - (a.weight || 0));
  let lastError: string = "";

  for (const modelConfig of models) {
    const provider = providers[modelConfig.provider];
    if (!provider) {
      lastError = `Provider ${modelConfig.provider} 不存在`;
      continue;
    }

    const baseUrl = provider.baseUrl || provider.baseURL || "";
    const apiKey = provider.apiKey || "";

    if (!baseUrl || !apiKey) {
      lastError = `Provider ${modelConfig.provider} 缺少baseUrl或apiKey`;
      continue;
    }

    try {
      const url = baseUrl.endsWith("/") ? baseUrl + "chat/completions" : baseUrl + "/chat/completions";
      
      const body = {
        model: modelConfig.model,
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: options.prompt },
              {
                type: "image_url",
                image_url: {
                  url: `data:image/${options.imageFormat};base64,${options.imageBase64}`,
                },
              },
            ],
          },
        ],
        max_tokens: options.maxTokens || taskConfig.maxTokens || 500,
        temperature: options.temperature ?? taskConfig.temperature ?? 0.5,
      };

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), options.timeout || 60000);

      const response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      clearTimeout(timeout);

      if (!response.ok) {
        const errorText = await response.text().catch(() => "");
        lastError = `HTTP ${response.status}: ${errorText.substring(0, 100)}`;
        continue;
      }

      const data = await response.json() as any;
      const content = data?.choices?.[0]?.message?.content;

      if (content) {
        return {
          success: true,
          content,
          model: modelConfig.model,
          provider: modelConfig.provider,
        };
      }

      lastError = "模型返回空内容";
    } catch (e: any) {
      const errorMsg = e?.name === "AbortError" ? "超时" : e?.message || String(e);
      lastError = `${modelConfig.provider}/${modelConfig.model} 失败: ${errorMsg}`;
    }
  }

  return { success: false, error: lastError };
}
