import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Api, AssistantMessage, AssistantMessageEvent, AssistantMessageEventStream, Context, Credential, Model, SimpleStreamOptions } from "@earendil-works/pi-ai";
import type { OAuthCredentials, OAuthLoginCallbacks } from "@earendil-works/pi-ai/oauth";
import { KIRO_API, type ExtensionConfig, loadConfig } from "./config.js";
import { DebugLogger } from "./debug-logger.js";
import type { DebugLogger as DebugLoggerInstance } from "./debug-logger.js";
import { omitAuthorizationHeaders } from "./headers.js";
import { createKiroOAuthProvider } from "./oauth.js";
import { createKiroModelRefresher, discoverKiroModels, type RefreshModelsContext } from "./model-discovery.js";

const EXTENSION_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const RUNTIME_PROVIDER_REGISTRATION_EVENT = "pi-multi-auth:runtime-provider-registration";
const MULTI_AUTH_PROVIDERS_REGISTERED_EVENT = "pi-multi-auth:providers-registered";

type KiroRuntimeState = { cwd?: string };
type KiroStreamModule = typeof import("./kiro.js");

function credentialFromEvent(payload: unknown): Credential | undefined {
  if (!payload || typeof payload !== "object") return undefined;
  const value = payload as Record<string, unknown>;
  const candidates = [value.credential, value.credentials, value.auth];
  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== "object") continue;
    const credential = candidate as Record<string, unknown>;
    if (credential.type === "oauth" && typeof credential.access === "string" && credential.access.length > 0) {
      return credential as unknown as Credential;
    }
    const kiro = credential.kiro;
    if (kiro && typeof kiro === "object") {
      const nested = kiro as Record<string, unknown>;
      if (nested.type === "oauth" && typeof nested.access === "string" && nested.access.length > 0) {
        return nested as unknown as Credential;
      }
    }
  }
  return undefined;
}
type KiroStreamSimple = (model: Model<Api>, context: Context, options?: SimpleStreamOptions) => AssistantMessageEventStream;

function createLazyModule<T>(importer: () => Promise<T>): { load(): Promise<T> } {
  let loaded: T | undefined;
  let promise: Promise<T> | undefined;
  return {
    load(): Promise<T> {
      if (loaded) return Promise.resolve(loaded);
      promise ??= importer().then((module) => {
        loaded = module;
        return module;
      });
      return promise;
    },
  };
}

const kiroStreamLoader = createLazyModule<KiroStreamModule>(() => import("./kiro.js"));

function createLazyKiroStream(config: ExtensionConfig, runtime: KiroRuntimeState, logger: DebugLoggerInstance): KiroStreamSimple {
  return (model, context, options) => {
    const streamPromise = kiroStreamLoader.load()
      .then(({ createKiroStream }) => createKiroStream(config, runtime, logger)(model, context, options));
    streamPromise.catch(() => undefined);

    const lazyStream = {
      async *[Symbol.asyncIterator](): AsyncIterator<AssistantMessageEvent> {
        const stream = await streamPromise;
        yield* stream;
      },
      result(): Promise<AssistantMessage> {
        return streamPromise.then((stream) => stream.result());
      },
      push(event: AssistantMessageEvent): void {
        void streamPromise.then((stream) => stream.push(event), () => undefined);
      },
      end(result?: AssistantMessage): void {
        void streamPromise.then((stream) => stream.end(result), () => undefined);
      },
    };

    return lazyStream as unknown as AssistantMessageEventStream;
  };
}

export default function kiroProviderExtension(pi: ExtensionAPI): void {
  const { config, warnings } = loadConfig(EXTENSION_ROOT);
  const logger = new DebugLogger({ extensionRoot: EXTENSION_ROOT, debug: config.debug });
  for (const warning of warnings) logger.warn("config_warning", { warning });

  if (!config.enabled) {
    logger.debug("extension_disabled", { providerId: config.providerId });
    return;
  }

  const oauthProvider = createKiroOAuthProvider(config.oauth, logger, {
    providerId: config.providerId,
    displayName: config.displayName,
  });
  const runtime: KiroRuntimeState = {};
  const streamSimple = createLazyKiroStream(config, runtime, logger);
  const providerHeaders = omitAuthorizationHeaders(config.headers);
  const refreshModels = createKiroModelRefresher(config, config.models, logger);
  let providerModels = config.models.map((model) => ({
    ...model,
    ...(model.headers ? { headers: omitAuthorizationHeaders(model.headers) } : {}),
  }));
  let runtimeProviderRegistrationEmitted = false;
  const emitRuntimeProviderRegistration = (force = false): void => {
    if (runtimeProviderRegistrationEmitted && !force) {
      logger.debug("runtime_provider_registration_skipped", {
        providerId: config.providerId,
        reason: "already_emitted",
      });
      return;
    }
    if (!pi.events) return;
    pi.events.emit(RUNTIME_PROVIDER_REGISTRATION_EVENT, {
      provider: config.providerId,
      displayName: config.displayName,
      baseUrl: config.upstreamUrl,
      api: KIRO_API,
      authHeader: false,
      headers: { ...providerHeaders },
      models: providerModels.map((model) => ({ ...model, ...(model.headers ? { headers: { ...model.headers } } : {}) })),
      streamSimple,
    });
    runtimeProviderRegistrationEmitted = true;
    logger.debug("runtime_provider_registration_emitted", {
      providerId: config.providerId,
      api: KIRO_API,
      modelCount: config.models.length,
    });
  };

  const registerProvider = (): void => {
    pi.registerProvider(config.providerId, {
      name: config.displayName,
      baseUrl: config.upstreamUrl,
      apiKey: config.apiKey,
      api: KIRO_API,
      authHeader: false,
      streamSimple,
      headers: providerHeaders,
      models: providerModels,
      refreshModels: async (context: RefreshModelsContext) => {
        const discoveredModels = await refreshModels(context);
        return discoveredModels.map((model) => ({
          ...model,
          ...(model.headers ? { headers: omitAuthorizationHeaders(model.headers) } : {}),
        }));
      },
      oauth: {
        name: oauthProvider.name,
        login: (callbacks: OAuthLoginCallbacks) => oauthProvider.login(callbacks),
        refreshToken: (credentials: OAuthCredentials) => oauthProvider.refreshToken(credentials),
        getApiKey: (credentials: OAuthCredentials) => oauthProvider.getApiKey(credentials),
        modifyModels: (models: Model<Api>[], credentials: OAuthCredentials) => oauthProvider.modifyModels?.(models, credentials) ?? models,
      },
    } as unknown as Parameters<ExtensionAPI["registerProvider"]>[1]);
  };

  const refreshAndRegister = async (credential?: Credential): Promise<void> => {
    let discoveredModels: ExtensionConfig["models"];
    try {
      discoveredModels = await discoverKiroModels({
        credential,
        allowNetwork: true,
        force: true,
        store: { read: async () => undefined, write: async () => undefined },
      });
    } catch (error) {
      logger.warn("model_discovery_refresh_failed", {
        providerId: config.providerId,
        error: error instanceof Error ? error.message : String(error),
      });
      return;
    }
    if (discoveredModels.length === 0) return;
    const nextModels = discoveredModels.map((model) => ({
      ...model,
      ...(model.headers ? { headers: omitAuthorizationHeaders(model.headers) } : {}),
    }));
    if (JSON.stringify(nextModels) === JSON.stringify(providerModels)) return;
    providerModels = nextModels;
    registerProvider();
    emitRuntimeProviderRegistration(true);
  };

  pi.on("session_start", (event, ctx) => {
    runtime.cwd = ctx.cwd;
    emitRuntimeProviderRegistration(true);
    const candidate = event as unknown as { credential?: Credential };
    void refreshAndRegister(candidate?.credential);
  });

  pi.on("before_agent_start", (_event, ctx) => {
    runtime.cwd = ctx.cwd;
    emitRuntimeProviderRegistration(true);
    return {};
  });

  pi.events?.on(MULTI_AUTH_PROVIDERS_REGISTERED_EVENT, (event: unknown) => {
    emitRuntimeProviderRegistration(true);
    void refreshAndRegister(credentialFromEvent(event));
  });

  // Pi 0.80 typings predate refreshModels; Pi 0.81 runtime consumes this field.
  registerProvider();
  emitRuntimeProviderRegistration(true);

  logger.debug("provider_registered", {
    providerId: config.providerId,
    api: KIRO_API,
    upstreamUrl: config.upstreamUrl,
    modelCount: config.models.length,
  });
}
