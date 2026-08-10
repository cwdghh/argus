/**
 * Runtime configuration, read from environment variables (and `.env`).
 *
 * Defaults target Alibaba Cloud DashScope (the model server for our default
 * model), but anything that speaks the OpenAI "chat completions" protocol
 * works (e.g. Ollama, LM Studio, vLLM, LiteLLM).
 */
export function getConfig() {
  return {
    // Base URL of the chat completions endpoint, without the trailing path.
    baseUrl: process.env.ARGUS_BASE_URL ?? "https://dashscope.aliyuncs.com/compatible-mode/v1",
    // API key. Leave unset for local servers that don't require one (Ollama).
    apiKey: process.env.ARGUS_API_KEY ?? process.env.OPENAI_API_KEY ?? "",
    // Model identifier understood by the endpoint.
    model: process.env.ARGUS_MODEL ?? "deepseek-v4-flash-0731",
    // Optional system prompt that shapes the agent's behaviour.
    systemPrompt:
      process.env.ARGUS_SYSTEM_PROMPT ??
      "You are a helpful coding agent. You can read files, write files, edit files, " +
        "and run shell commands to help the user. Prefer using tools over guessing. " +
        "Keep answers concise.",
  };
}
