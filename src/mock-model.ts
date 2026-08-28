import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

const port = parsePort(process.env.MOCK_MODEL_PORT ?? "8080");
const model = process.env.MOCK_MODEL_NAME?.trim() || "grookie-mock";
const scenario = process.env.MOCK_MODEL_SCENARIO?.trim() || "reply";
const configuredResponse = process.env.MOCK_MODEL_RESPONSE?.trim();
const toolName = process.env.MOCK_MODEL_TOOL_NAME?.trim() || "mock_action";

const server = createServer((request, response) => {
  void handleRequest(request, response).catch((error: unknown) => {
    console.error(error);
    sendJson(response, 500, { error: { message: "mock server error" } });
  });
});

server.listen(port, "127.0.0.1", () => {
  console.log(`Mock OpenAI Chat Completions server listening on http://127.0.0.1:${port}/v1`);
  console.log(`model=${model} scenario=${scenario}`);
});

async function handleRequest(
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  if (request.method === "GET" && request.url === "/v1/models") {
    sendJson(response, 200, {
      object: "list",
      data: [{ id: model, object: "model", owned_by: "grookie-test" }],
    });
    return;
  }

  if (request.method !== "POST" || request.url !== "/v1/chat/completions") {
    sendJson(response, 404, { error: { message: "not found" } });
    return;
  }

  const body = JSON.parse(await readBody(request)) as ChatCompletionRequest;
  if (scenario === "tool-call") {
    if (body.messages?.some((message) => message.role === "tool")) {
      const responseText = configuredResponse ?? "Mock tool call completed.";
      if (body.stream === true) sendStream(response, responseText);
      else sendJson(response, 200, completionFor(responseText));
      return;
    }
    if (!body.tools?.length) {
      sendJson(response, 400, {
        error: { message: "tool-call scenario requires tools in the request" },
      });
      return;
    }
    if (body.stream === true) sendToolCallStream(response);
    else sendJson(response, 200, toolCallCompletion());
    return;
  }

  const responseText = configuredResponse ?? responseFor(body);
  if (body.stream === true) {
    sendStream(response, responseText);
  } else {
    sendJson(response, 200, completionFor(responseText));
  }
}

function responseFor(request: ChatCompletionRequest): string {
  const lastMessage = request.messages?.at(-1);
  return `Mock response received for ${lastMessage?.role ?? "unknown"} input.`;
}

function toolCallCompletion(): ChatCompletionResponse {
  return {
    id: `chatcmpl-mock-${Date.now()}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1_000),
    model,
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "call_mock_1",
              type: "function",
              function: { name: toolName, arguments: '{"ok":true}' },
            },
          ],
        },
        finish_reason: "tool_calls",
      },
    ],
  };
}

function completionFor(text: string): ChatCompletionResponse {
  return {
    id: `chatcmpl-mock-${Date.now()}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1_000),
    model,
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: text },
        finish_reason: "stop",
      },
    ],
  };
}

function sendStream(response: ServerResponse, text: string): void {
  response.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  const id = `chatcmpl-mock-${Date.now()}`;
  const chunks = text.match(/.{1,24}(?:\s+|$)|.{1,24}/g) ?? [text];
  for (const [index, chunk] of chunks.entries()) {
    writeEvent(response, {
      id,
      object: "chat.completion.chunk",
      created: Math.floor(Date.now() / 1_000),
      model,
      choices: [
        {
          index: 0,
          delta: index === 0 ? { role: "assistant", content: chunk } : { content: chunk },
          finish_reason: null,
        },
      ],
    });
  }
  writeEvent(response, {
    id,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1_000),
    model,
    choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
  });
  response.write("data: [DONE]\n\n");
  response.end();
}

function sendToolCallStream(response: ServerResponse): void {
  response.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  const id = `chatcmpl-mock-${Date.now()}`;
  writeEvent(response, {
    id,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1_000),
    model,
    choices: [
      {
        index: 0,
        delta: {
          role: "assistant",
          tool_calls: [
            {
              index: 0,
              id: "call_mock_1",
              type: "function",
              function: { name: toolName, arguments: '{"ok":true}' },
            },
          ],
        },
        finish_reason: null,
      },
    ],
  });
  writeEvent(response, {
    id,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1_000),
    model,
    choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
  });
  response.write("data: [DONE]\n\n");
  response.end();
}

function writeEvent(response: ServerResponse, value: unknown): void {
  response.write(`data: ${JSON.stringify(value)}\n\n`);
}

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk: string) => {
      body += chunk;
      if (body.length > 1_000_000) reject(new Error("request body is too large"));
    });
    request.on("end", () => resolve(body));
    request.on("error", reject);
  });
}

function sendJson(response: ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value);
  response.writeHead(status, { "Content-Type": "application/json" });
  response.end(body);
}

function parsePort(value: string): number {
  const portValue = Number.parseInt(value, 10);
  if (!Number.isInteger(portValue) || portValue < 1 || portValue > 65_535) {
    throw new Error("MOCK_MODEL_PORT must be a valid TCP port");
  }
  return portValue;
}

interface ChatCompletionRequest {
  messages?: readonly { role?: string }[];
  tools?: readonly unknown[];
  stream?: boolean;
}

interface ChatCompletionResponse {
  id: string;
  object: "chat.completion";
  created: number;
  model: string;
  choices: readonly ChatCompletionChoice[];
}

interface ChatCompletionChoice {
  index: number;
  message?: {
    role: "assistant";
    content: string | null;
    tool_calls?: readonly ToolCall[];
  };
  delta?: { role?: "assistant"; content?: string };
  finish_reason: "stop" | "tool_calls" | null;
}

interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}
