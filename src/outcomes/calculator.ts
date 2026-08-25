import type { Candle } from "../gmgn/index.js";
import type { CalculatedOutcome, RealtimePrice } from "./types.js";

export const CANDLE_MS = 30_000;
const PERIODS = [
  ["return1m", 60_000],
  ["return5m", 5 * 60_000],
  ["return15m", 15 * 60_000],
  ["return1h", 60 * 60_000],
] as const;

function returnFrom(price: number, sentPrice: number): number {
  return (price - sentPrice) / sentPrice;
}

export function calculateOutcome(
  sentAt: number,
  sentPrice: number,
  checkpointMs: number,
  candles: readonly Candle[],
  realtimePrices: readonly RealtimePrice[],
): CalculatedOutcome {
  if (
    !Number.isSafeInteger(sentAt) ||
    !Number.isSafeInteger(checkpointMs) ||
    checkpointMs <= 0 ||
    !Number.isFinite(sentPrice) ||
    sentPrice <= 0
  ) {
    throw new RangeError("Outcome calculation requires valid signal time, price, and checkpoint");
  }
  const checkpointAt = sentAt + checkpointMs;
  const firstFullCandleAt = Math.ceil(sentAt / CANDLE_MS) * CANDLE_MS;
  const eligibleCandles = [...candles]
    .filter(
      (candle) =>
        candle.timeMs >= firstFullCandleAt &&
        candle.timeMs + CANDLE_MS <= checkpointAt,
    )
    .sort((left, right) => left.timeMs - right.timeMs);
  for (let index = 1; index < eligibleCandles.length; index += 1) {
    if (eligibleCandles[index]?.timeMs === eligibleCandles[index - 1]?.timeMs) {
      throw new Error("Outcome candles contain a duplicate opening time");
    }
  }
  const interim = realtimePrices.filter(
    (item) =>
      item.capturedAt >= sentAt &&
      item.capturedAt < firstFullCandleAt &&
      item.capturedAt <= checkpointAt &&
      Number.isFinite(item.price) &&
      item.price > 0,
  );
  const highPrices = [
    sentPrice,
    ...interim.map((item) => item.price),
    ...eligibleCandles.map((candle) => candle.high),
  ];
  const lowPrices = [
    sentPrice,
    ...interim.map((item) => item.price),
    ...eligibleCandles.map((candle) => candle.low),
  ];
  const doublePrice = sentPrice * 2;
  const firstRealtimeDouble = [...interim]
    .sort((left, right) => left.capturedAt - right.capturedAt)
    .find((item) => item.price >= doublePrice)?.capturedAt;
  const firstCandleDouble = eligibleCandles.find(
    (candle) => candle.high >= doublePrice,
  )?.timeMs;
  const doubleTouches = [
    ...(firstRealtimeDouble === undefined ? [] : [firstRealtimeDouble - sentAt]),
    ...(firstCandleDouble === undefined
      ? []
      : [firstCandleDouble + CANDLE_MS - sentAt]),
  ];
  const returns: Partial<Record<(typeof PERIODS)[number][0], number>> = {};
  for (const [field, duration] of PERIODS) {
    if (duration > checkpointMs) {
      continue;
    }
    const targetAt = sentAt + duration;
    const candle = eligibleCandles.findLast(
      (item) => item.timeMs + CANDLE_MS <= targetAt,
    );
    if (candle !== undefined) {
      returns[field] = returnFrom(candle.close, sentPrice);
    }
  }
  return {
    ...returns,
    mfe: returnFrom(Math.max(...highPrices), sentPrice),
    mae: returnFrom(Math.min(...lowPrices), sentPrice),
    ...(doubleTouches.length === 0 ? {} : { timeTo2xMs: Math.min(...doubleTouches) }),
    candleCount: eligibleCandles.length,
  };
}

export function fixedTerminalOutcome(
  checkpointMs: number,
  value: 0 | -1,
): CalculatedOutcome {
  const returns: Partial<Record<(typeof PERIODS)[number][0], number>> = {};
  for (const [field, duration] of PERIODS) {
    if (duration <= checkpointMs) {
      returns[field] = value;
    }
  }
  return {
    ...returns,
    mfe: 0,
    mae: value,
    candleCount: 0,
  };
}
