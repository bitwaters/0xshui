import type { AppConfig } from "./schema.js";

export interface RuntimeCredentials {
  readonly gmgnApiKey: string;
  readonly telegram: {
    readonly botToken: string;
    readonly chatId: string;
  } | null;
}

export class CredentialError extends Error {
  public constructor(variableName: string, reason: string) {
    super(`${variableName}: ${reason}`);
    this.name = "CredentialError";
  }
}

function requireNonEmpty(
  environment: NodeJS.ProcessEnv,
  variableName: string,
): string {
  const value = environment[variableName]?.trim();
  if (value === undefined || value.length === 0) {
    throw new CredentialError(variableName, "required value is missing");
  }
  return value;
}

function validateTelegramToken(token: string): void {
  if (!/^\d{5,}:[A-Za-z0-9_-]{20,}$/.test(token)) {
    throw new CredentialError("TELEGRAM_BOT_TOKEN", "value has an invalid format");
  }
}

function validateTelegramChatId(chatId: string): void {
  const isNumericChatId = /^-?\d+$/.test(chatId);
  const isChannelUsername = /^@[A-Za-z][A-Za-z0-9_]{4,}$/.test(chatId);
  if (!isNumericChatId && !isChannelUsername) {
    throw new CredentialError("TELEGRAM_CHAT_ID", "value has an invalid format");
  }
}

export function loadRuntimeCredentials(
  config: Readonly<AppConfig>,
  environment: NodeJS.ProcessEnv = process.env,
): RuntimeCredentials {
  const gmgnApiKey = requireNonEmpty(environment, "GMGN_API_KEY");

  if (!config.telegram.enabled) {
    return Object.freeze({ gmgnApiKey, telegram: null });
  }

  const botToken = requireNonEmpty(environment, "TELEGRAM_BOT_TOKEN");
  const chatId = requireNonEmpty(environment, "TELEGRAM_CHAT_ID");
  validateTelegramToken(botToken);
  validateTelegramChatId(chatId);

  return Object.freeze({
    gmgnApiKey,
    telegram: Object.freeze({ botToken, chatId }),
  });
}
