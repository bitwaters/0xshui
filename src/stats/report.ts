import type { Bot } from "grammy";

import type { PersistenceRepository } from "../db/index.js";
import { aggregateStatistics, type SignalStatistics } from "./stats.js";

export type StatsRequest = "current" | "today" | "7d" | "30d" | "detail";

function localParts(timestamp: number, timeZone: string): {
  readonly year: number;
  readonly month: number;
  readonly day: number;
} {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(timestamp);
  const value = (type: string) => Number(parts.find((part) => part.type === type)?.value);
  return { year: value("year"), month: value("month"), day: value("day") };
}

function zonedMidnightUtc(
  year: number,
  month: number,
  day: number,
  timeZone: string,
): number {
  const desired = Date.UTC(year, month - 1, day);
  let candidate = desired;
  for (let iteration = 0; iteration < 4; iteration += 1) {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    }).formatToParts(candidate);
    const value = (type: string) => Number(parts.find((part) => part.type === type)?.value);
    const represented = Date.UTC(
      value("year"),
      value("month") - 1,
      value("day"),
      value("hour"),
      value("minute"),
      value("second"),
    );
    candidate += desired - represented;
  }
  return candidate;
}

export function localDateKey(timestamp: number, timeZone: string): string {
  const { year, month, day } = localParts(timestamp, timeZone);
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

export function resolveStatsRange(
  request: StatsRequest,
  now: number,
  timeZone: string,
): { readonly from: number; readonly to: number; readonly label: string } {
  if (request === "current" || request === "detail") {
    return { from: 0, to: now + 1, label: "当前版本累计" };
  }
  if (request === "7d" || request === "30d") {
    const days = request === "7d" ? 7 : 30;
    return { from: now - days * 86_400_000, to: now + 1, label: `近 ${days} 天` };
  }
  const current = localParts(now, timeZone);
  const from = zonedMidnightUtc(current.year, current.month, current.day, timeZone);
  const nextCalendarDay = new Date(Date.UTC(current.year, current.month - 1, current.day + 1));
  const to = zonedMidnightUtc(
    nextCalendarDay.getUTCFullYear(),
    nextCalendarDay.getUTCMonth() + 1,
    nextCalendarDay.getUTCDate(),
    timeZone,
  );
  return { from, to, label: "今日" };
}

export function parseStatsRequest(argument: string): StatsRequest | null {
  const normalized = argument.trim().toLowerCase();
  if (normalized === "") return "current";
  if (normalized === "7d" || normalized === "30d" || normalized === "detail") {
    return normalized;
  }
  return null;
}

function percentage(value: number | null): string {
  return value === null ? "样本不足" : `${Math.round(value * 100)}%`;
}

function signed(value: number | null): string {
  return value === null ? "样本不足" : `${value >= 0 ? "+" : ""}${Math.round(value * 100)}%`;
}

function latency(value: number | null): string {
  return value === null ? "样本不足" : `${(value / 1_000).toFixed(1)} 秒`;
}

function sourceLabel(source: string): string {
  switch (source) {
    case "curve_acceleration":
      return "曲线加速";
    case "fast_rank":
      return "1m 快榜";
    case "cross_source":
      return "跨榜启动";
    case "double_confirmation":
      return "双榜确认";
    default:
      return "未知来源";
  }
}

function reviewStage(value: SignalStatistics["reviewStage"]): string {
  if (value === "baseline") return "已形成基线";
  if (value === "first_review") return "可进行首次复盘";
  return "持续采集中";
}

export function renderStatisticsCard(
  stats: SignalStatistics,
  label: string,
  detail = false,
): string {
  const lines = [
    `📊 <b>BSC 信号统计 · ${label}</b>`,
    "",
    `推送：${stats.signals}`,
    `已评估 15m：${stats.evaluated15}/${stats.due15}`,
    `已评估 1h：${stats.evaluated1h}/${stats.due1h}`,
    `待满 15m：${stats.pending15}`,
    `有效 T+1h 样本：${stats.validSamples1h}（${reviewStage(stats.reviewStage)}）`,
    `下一复盘节点：${stats.nextReviewAt}`,
    "",
    `15m 命中率：${percentage(stats.hitRate15)} (${stats.hit15}/${stats.evaluated15})`,
    `1h 大涨率：${percentage(stats.largeGainRate1h)} (${stats.largeGain1h}/${stats.evaluated1h})`,
    `1m/5m/15m/1h 中位收益：${[
      stats.medianReturn1m,
      stats.medianReturn5m,
      stats.medianReturn15m,
      stats.medianReturn1h,
    ]
      .map(signed)
      .join(" · ")}`,
    `15m 中位 MFE / MAE：${signed(stats.medianMfe15)} / ${signed(stats.medianMae15)}`,
    `1h 中位 MFE / MAE：${signed(stats.medianMfe1h)} / ${signed(stats.medianMae1h)}`,
    "",
    `曲线毕业率：${percentage(stats.curveGraduationRate)} (${stats.graduatedCurves}/${stats.knownCurveGraduations})`,
    `双榜确认率：${percentage(stats.confirmationRate)} (${stats.confirmed}/${stats.signals})`,
    `中位推送延迟：${latency(stats.medianLatencyMs)}`,
    `15m 数据覆盖率：${percentage(stats.coverage15)} (${stats.evaluated15}/${stats.due15})`,
    `1h 数据覆盖率：${percentage(stats.coverage1h)} (${stats.evaluated1h}/${stats.due1h})`,
  ];
  if (detail) {
    lines.push("", "<b>按信号来源</b>");
    for (const source of stats.sources) {
      lines.push(
        `${sourceLabel(source.source)}：${source.signals} 条，命中 ${source.hit15}/${source.eligible15}，` +
          `MFE ${signed(source.medianMfe)}，MAE ${signed(source.medianMae)}，` +
          `平均延迟 ${latency(source.averageLatencyMs)}`,
      );
    }
  }
  lines.push(
    "",
    "命中：15 分钟内最高涨幅 ≥ 30%；1 小时大涨 ≥ 100%",
    "注：最高涨幅为价格触达研究指标，不代表可成交收益。",
    "仅为数据筛选信号，不代表安全或可成交收益。",
  );
  return lines.join("\n");
}

export interface StatsServiceOptions {
  readonly repository: PersistenceRepository;
  readonly timeZone: string;
  readonly hitGain: number;
  readonly largeGain: number;
  readonly configVersion: number;
  readonly now?: () => number;
}

export class StatsService {
  private readonly now: () => number;

  public constructor(private readonly options: StatsServiceOptions) {
    this.now = options.now ?? Date.now;
  }

  public render(request: StatsRequest): string {
    const now = this.now();
    const range = resolveStatsRange(request, now, this.options.timeZone);
    const stored = this.options.repository.getConfigVersion(this.options.configVersion);
    if (stored === null) throw new Error("Current statistics config version does not exist");
    const from = Math.max(range.from, stored.createdAt);
    const rows = this.options.repository.listStatisticsSignals(
      from,
      range.to,
      this.options.configVersion,
    );
    return renderStatisticsCard(
      aggregateStatistics(rows, now, this.options.hitGain, this.options.largeGain),
      `${range.label} · v${this.options.configVersion}`,
      request === "detail",
    );
  }

  public async sendDailyOnce(send: (text: string) => Promise<void>): Promise<boolean> {
    const now = this.now();
    const date = localDateKey(now, this.options.timeZone);
    if (!this.options.repository.claimDailyReport(date, now)) {
      return false;
    }
    await send(this.render("today"));
    return true;
  }
}

export function registerStatsCommand(
  bot: Bot,
  service: StatsService,
  allowedChatId: string,
): void {
  bot.command("stats", async (context) => {
    if (String(context.chat.id) !== allowedChatId) {
      return;
    }
    const request = parseStatsRequest(context.match);
    if (request === null) {
      await context.reply("用法：/stats、/stats 7d、/stats 30d 或 /stats detail");
      return;
    }
    await context.reply(service.render(request), { parse_mode: "HTML" });
  });
}
