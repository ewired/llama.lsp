import {
  createConnection,
  DidChangeConfigurationNotification,
  InitializeParams,
  InitializeResult,
  InlineCompletionItem,
  InlineCompletionParams,
  ProposedFeatures,
  TextDocuments,
  TextDocumentSyncKind,
} from "vscode-languageserver/node.js";

import { TextDocument } from "vscode-languageserver-textdocument";

import * as Mollitia from "mollitia";

const connection = createConnection(ProposedFeatures.all);

const documents = new TextDocuments(TextDocument);
let hasConfigurationCapability = false;

interface ServerSettings {
  llamaEndpoint: string;
  nPredict: number;
  temperature: number;
  topK: number;
  topP: number;
  debounceMs: number;
  t_max_prompt_ms: number;
  t_max_predict_ms: number;
}

interface ExtraContext {
  filename: string;
  text: string;
}

interface InfillRequest {
  input_prefix: string;
  input_suffix: string;
  input_extra: ExtraContext[];
  prompt: string;
  n_predict: number;
  temperature: number;
  top_k: number;
  top_p: number;
  n_indent: number;
  samplers: string[];
  stream: boolean;
  cache_prompt: boolean;
  t_max_prompt_ms: number;
  t_max_predict_ms: number;
  response_fields: string[];
  id_slot?: number;
  stop?: string[];
}

const DEFAULT_DEBOUNCE_MS = 150;

const defaultSettings: ServerSettings = {
  llamaEndpoint: "http://127.0.0.1:8012/infill",
  nPredict: 128,
  temperature: 0.0,
  topK: 40,
  topP: 0.90,
  debounceMs: DEFAULT_DEBOUNCE_MS,
  t_max_prompt_ms: 500,
  t_max_predict_ms: 1000,
};

const CONFIG_SECTION = "llamaLsp";

let globalSettings: ServerSettings = defaultSettings;

const documentSettings = new Map<string, Thenable<ServerSettings>>();

const abortControllers = new Map<string, AbortController>();

interface DebounceEntry {
  timer: ReturnType<typeof setTimeout>;
  resolve: () => void;
  reject: (reason?: unknown) => void;
}
const debounceEntries = new Map<string, DebounceEntry>();

const slidingCountBreaker = new Mollitia.SlidingCountBreaker({
  name: "llamaCircuitBreakerModule",
  slidingWindowSize: 5,
  minimumNumberOfCalls: 5,
  failureRateThreshold: 100,
  openStateDelay: 30000,
  onError: (error: unknown) =>
    !(error instanceof Error && error.name === "AbortError"),
});

slidingCountBreaker.on("state-changed", (state: string) => {
  connection.console.log(`Circuit breaker state: ${state}`);
});

const llamaCircuitBreaker = new Mollitia.Circuit({
  name: "llamaInfill",
  func: async (
    endpoint: string,
    request: InfillRequest,
    signal?: AbortSignal,
  ) => {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(request),
      signal,
    });

    if (!response.ok) {
      connection.console.log(
        `Llama infill error: ${response.status} ${response.statusText}`,
      );
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    const data = await response.json();

    if (
      typeof data !== "object" ||
      data === null ||
      !("content" in data) ||
      typeof data.content !== "string"
    ) {
      connection.console.log("Llama infill error: Invalid response format");
      throw new Error("Invalid response format");
    }

    return data.content;
  },
  options: {
    modules: [slidingCountBreaker],
  },
});

connection.onInitialize((params: InitializeParams) => {
  const capabilities = params.capabilities;

  hasConfigurationCapability =
    !!(capabilities.workspace && capabilities.workspace.configuration);

  const result: InitializeResult = {
    capabilities: {
      textDocumentSync: TextDocumentSyncKind.Incremental,
      inlineCompletionProvider: true,
    },
  };

  if (capabilities.workspace && capabilities.workspace.workspaceFolders) {
    result.capabilities.workspace = {
      workspaceFolders: {
        supported: true,
      },
    };
  }

  return result;
});

connection.onInitialized(() => {
  if (hasConfigurationCapability) {
    connection.client.register(
      DidChangeConfigurationNotification.type,
      undefined,
    );
  }
});

connection.onDidChangeConfiguration((change) => {
  if (hasConfigurationCapability) {
    documentSettings.clear();
  } else {
    const settings = change.settings?.[CONFIG_SECTION] || defaultSettings;
    globalSettings = { ...defaultSettings, ...settings };
  }
});

function getDocumentSettings(resource: string): Thenable<ServerSettings> {
  if (!hasConfigurationCapability) {
    return Promise.resolve(globalSettings);
  }

  const cached = documentSettings.get(resource);
  if (cached) {
    return cached;
  }

  const requestPromise = connection.workspace.getConfiguration({
    scopeUri: resource,
    section: CONFIG_SECTION,
  })
    .then((config) => {
      return { ...defaultSettings, ...(config || {}) };
    })
    .catch((err) => {
      connection.console.log(
        `Configuration fetch error for ${resource}: ${
          err instanceof Error ? err.message : err
        }`,
      );
      if (documentSettings.get(resource) === requestPromise) {
        documentSettings.delete(resource);
      }
      throw err;
    });

  documentSettings.set(resource, requestPromise);
  return requestPromise;
}

function buildInfillRequest(
  document: TextDocument,
  position: { line: number; character: number },
  settings: ServerSettings,
): InfillRequest {
  const text = document.getText();
  const offset = document.offsetAt(position);

  const prefix = text.substring(0, offset);
  const suffix = text.substring(offset);

  const lineStart = text.lastIndexOf("\n", offset - 1) + 1;
  const lineEnd = text.indexOf("\n", offset);
  const lineText = lineEnd === -1
    ? text.substring(lineStart)
    : text.substring(lineStart, lineEnd);
  const leadingWhitespace = (lineText.match(/^\s*/) || [""])[0];
  const indent = leadingWhitespace.replace(/\t/g, "    ").length;

  return {
    input_prefix: prefix,
    input_suffix: suffix,
    input_extra: [],
    prompt: "",
    n_predict: settings.nPredict,
    temperature: settings.temperature,
    top_k: settings.topK,
    top_p: settings.topP,
    n_indent: indent,
    samplers: ["top_k", "top_p", "infill"],
    stream: false,
    cache_prompt: true,
    t_max_prompt_ms: settings.t_max_prompt_ms,
    t_max_predict_ms: settings.t_max_predict_ms,
    response_fields: ["content"],
  };
}

connection.onRequest(
  "textDocument/inlineCompletion",
  async (params: InlineCompletionParams) => {
    const { textDocument, position } = params;
    const document = documents.get(textDocument.uri);

    if (!document) {
      return [];
    }

    const debounceDelay = (await getDocumentSettings(document.uri))
      .debounceMs || DEFAULT_DEBOUNCE_MS;

    const existingEntry = debounceEntries.get(document.uri);
    if (existingEntry) {
      clearTimeout(existingEntry.timer);
      existingEntry.reject(new Error("Cancelled due to new request"));
      debounceEntries.delete(document.uri);
    }

    let resolveDebounce!: () => void;
    let rejectDebounce!: (reason?: unknown) => void;
    const debouncePromise = new Promise<void>((resolve, reject) => {
      resolveDebounce = resolve;
      rejectDebounce = reject;
    });

    const timer = setTimeout(() => {
      debounceEntries.delete(document.uri);
      resolveDebounce();
    }, debounceDelay);

    debounceEntries.set(document.uri, {
      timer,
      resolve: resolveDebounce,
      reject: rejectDebounce,
    });

    try {
      await debouncePromise;
    } catch (_err) {
      return [];
    }

    const previousController = abortControllers.get(document.uri);
    if (previousController) {
      previousController.abort();
      abortControllers.delete(document.uri);
    }

    const controller = new AbortController();
    abortControllers.set(document.uri, controller);

    try {
      const rawSettings = await getDocumentSettings(document.uri);
      const config: ServerSettings = {
        ...defaultSettings,
        ...(rawSettings || {}),
      };

      const request = buildInfillRequest(document, position, config);

      const completion: string = await llamaCircuitBreaker.execute(
        config.llamaEndpoint,
        request,
        controller.signal,
      );

      if (!completion) {
        return [];
      }

      const item: InlineCompletionItem = {
        insertText: completion,
      };

      return [item];
    } catch (_error) {
      return [];
    } finally {
      const currentController = abortControllers.get(document.uri);
      if (currentController === controller) {
        abortControllers.delete(document.uri);
      }
    }
  },
);

connection.onShutdown(() => {
  connection.console.log("Server shutting down...");

  for (const [, controller] of abortControllers) {
    controller.abort();
  }
  abortControllers.clear();

  for (const [, entry] of debounceEntries) {
    clearTimeout(entry.timer);
    entry.reject(new Error("Server shutting down"));
  }
  debounceEntries.clear();

  documentSettings.clear();

  connection.console.log("Shutdown complete");
});

connection.onExit(() => {
  connection.console.log("Server exiting");
});

documents.listen(connection);
connection.listen();

documents.onDidClose((change) => {
  documentSettings.delete(change.document.uri);

  const controller = abortControllers.get(change.document.uri);
  if (controller) {
    controller.abort();
    abortControllers.delete(change.document.uri);
  }
  const debounceEntry = debounceEntries.get(change.document.uri);
  if (debounceEntry) {
    clearTimeout(debounceEntry.timer);
    debounceEntry.reject(new Error("Document closed"));
    debounceEntries.delete(change.document.uri);
  }
});
