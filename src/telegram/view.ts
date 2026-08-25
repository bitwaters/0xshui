import { InlineKeyboard } from "grammy";

import type { MoveClass, TriggerKind } from "../detection/index.js";

const BSC_ADDRESS = /^0x[0-9a-f]{40}$/;
const MAX_CARD_LENGTH = 3_500;

export interface SignalCardModel {
  readonly tokenKey: string;
  readonly name?: string;
  readonly symbol?: string;
  readonly lifecycle: "curve" | "graduated";
  readonly trigger: TriggerKind;
  readonly moveClass: MoveClass;
  readonly price?: number;
  readonly marketCap?: number;
  readonly rank1m?: number;
  readonly rank5m?: number;
  readonly confirmed: boolean;
}

export interface RenderedSignalCard {
  readonly text: string;
  readonly keyboard: InlineKeyboard;
}

function truncate(value: string, maximum: number): string {
  const characters = Array.from(value.trim());
  return characters.length <= maximum
    ? characters.join("")
    : `${characters.slice(0, maximum - 1).join("")}…`;
}

export function escapeTelegramHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function finiteNonNegative(value: number | undefined, field: string): number | undefined {
  if (value !== undefined && (!Number.isFinite(value) || value < 0)) {
    throw new RangeError(`${field} must be a finite non-negative number`);
  }
  return value;
}

function formatUsd(value: number): string {
  if (value >= 1_000) {
    return `$${new Intl.NumberFormat("en-US", {
      notation: "compact",
      maximumFractionDigits: 2,
    }).format(value)}`;
  }
  return `$${value.toLocaleString("en-US", { maximumSignificantDigits: 6 })}`;
}

function triggerLabel(trigger: TriggerKind): string {
  switch (trigger) {
    case "curve_acceleration":
      return "Bonding Curve 加速";
    case "fast_rank":
      return "1m 热榜突破";
    case "cross_source":
      return "双来源启动";
  }
}

function movementLine(moveClass: MoveClass): string | null {
  switch (moveClass) {
    case "normal":
      return null;
    case "fast_rise":
      return "⚠️ 短时快速拉升，请注意追高风险";
    case "observation_only":
      return "🚨 极端波动，仅作观察信号";
    case "unknown":
      return "⚠️ 暂无完整的发现价对比";
  }
}

function displayName(model: SignalCardModel): string {
  const name = model.name === undefined ? "Unknown Token" : truncate(model.name, 64);
  const symbol = model.symbol === undefined ? "" : ` (${truncate(model.symbol, 24)})`;
  return escapeTelegramHtml(`${name}${symbol}`);
}

export function buildSignalKeyboard(tokenKey: string): InlineKeyboard {
  if (!BSC_ADDRESS.test(tokenKey)) {
    throw new Error("Signal keyboard requires a normalized BSC address");
  }
  return new InlineKeyboard()
    .url("GMGN", `https://gmgn.ai/bsc/token/${tokenKey}`)
    .url("BscScan", `https://bscscan.com/token/${tokenKey}`)
    .row()
    .copyText("复制合约", tokenKey);
}

export function renderSignalCard(model: SignalCardModel): RenderedSignalCard {
  if (!BSC_ADDRESS.test(model.tokenKey)) {
    throw new Error("Signal card requires a normalized BSC address");
  }
  const price = finiteNonNegative(model.price, "price");
  const marketCap = finiteNonNegative(model.marketCap, "marketCap");
  for (const [field, rank] of [
    ["rank1m", model.rank1m],
    ["rank5m", model.rank5m],
  ] as const) {
    if (rank !== undefined && (!Number.isSafeInteger(rank) || rank < 1 || rank > 100)) {
      throw new RangeError(`${field} must be an integer between 1 and 100`);
    }
  }

  const lines = [
    `${model.confirmed ? "🔥" : "⚡"} <b>${model.confirmed ? "趋势确认" : "BSC Early Signal"}</b>`,
    `<b>${displayName(model)}</b>`,
    `阶段：${model.lifecycle === "curve" ? "Bonding Curve" : "已毕业 / DEX"}`,
    `信号：${triggerLabel(model.trigger)}`,
  ];
  if (price !== undefined) {
    lines.push(`价格：${formatUsd(price)}`);
  }
  if (marketCap !== undefined) {
    lines.push(`市值：${formatUsd(marketCap)}`);
  }
  const ranks = [
    model.rank1m === undefined ? null : `1m #${model.rank1m}`,
    model.rank5m === undefined ? null : `5m #${model.rank5m}`,
  ].filter((value): value is string => value !== null);
  if (ranks.length > 0) {
    lines.push(`热度：${ranks.join(" · ")}`);
  }
  lines.push("安全：GMGN 风险检查通过");
  const movement = movementLine(model.moveClass);
  if (movement !== null) {
    lines.push(movement);
  }
  lines.push(`合约：<code>${model.tokenKey}</code>`);
  const text = lines.join("\n");
  if (text.length > MAX_CARD_LENGTH) {
    throw new Error("Rendered Telegram signal card exceeded the safe length limit");
  }
  return { text, keyboard: buildSignalKeyboard(model.tokenKey) };
}
