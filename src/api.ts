// Keep the bare specifier: VS Code patches `require('https')` in the extension
// host to honour the system/configured proxy. `node:https` bypasses that patch.
import * as https from 'https';

const BALANCE_URL = 'https://ollama.com/api/balance';
const USAGE_URL = 'https://ollama.com/api/usage';
const MAX_RESPONSE_BYTES = 1_048_576;

const SESSION_WINDOW_MS = 5 * 3600_000;
const WEEK_MS = 7 * 86400_000;

type UnknownRecord = Record<string, unknown>;

export interface ModelUsage {
  name: string;
  request_count: number;
  usage_usd?: number;
}

export interface LimitUsage {
  /** Fraction of the window used (0..1). */
  usage: number;
  /** Server-provided next reset time (ISO 8601, UTC). */
  resets_at: string;
  models: ModelUsage[];
}

export interface CreditUsage {
  /** Fraction of the included allowance used (0..1). */
  usage: number;
  balance_usd: number;
  allowance_usd: number;
  period: {
    from: string;
    until: string;
  };
  purchased_usd?: number;
  models: ModelUsage[];
}

export interface SpendUsage {
  range: string;
  from: string;
  until: string;
  /** Absent when the plan does not report USD spend for this range. */
  cost_usd?: number;
  request_count: number;
  models: ModelUsage[];
}

/**
 * Normalized usage model.
 *
 * Ollama has two account shapes:
 *  - legacy plans expose a 5h session and a weekly quota;
 *  - credit plans expose a monthly included allowance in USD.
 * Both shapes are returned by `GET /api/balance`.
 */
export interface UsageResponse {
  plan: 'legacy' | 'credits';
  session?: LimitUsage;
  weekly?: LimitUsage;
  credits?: CreditUsage;
  spend?: SpendUsage;
}

export class UsageApiError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UsageApiError';
  }
}

function isRecord(value: unknown): value is UnknownRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function asRecord(value: unknown, name: string): UnknownRecord {
  if (!isRecord(value)) {
    throw new UsageApiError(`Invalid ${name} in Ollama response.`);
  }

  return value;
}

function asString(value: unknown, name: string): string {
  if (typeof value !== 'string') {
    throw new UsageApiError(`Invalid ${name} in Ollama response.`);
  }

  return value;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function asNumber(value: unknown, name: string): number {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  // The API occasionally serializes numbers as strings.
  if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) {
    return Number(value);
  }

  throw new UsageApiError(`Invalid ${name} in Ollama response.`);
}

function optionalNumber(value: unknown): number | undefined {
  try {
    return value === undefined || value === null ? undefined : asNumber(value, 'value');
  } catch {
    return undefined;
  }
}

function clampFraction(value: number): number {
  return Math.min(1, Math.max(0, value));
}

/** Percent remaining (0..100) → fraction used (0..1). */
function usedFromRemaining(remainingPercent: number): number {
  return clampFraction((100 - Math.min(100, Math.max(0, remainingPercent))) / 100);
}

function parseModels(value: unknown, name: string): ModelUsage[] {
  if (value === undefined || value === null) {
    return [];
  }

  if (Array.isArray(value)) {
    return value.flatMap((item, index) => {
      if (!isRecord(item)) {
        throw new UsageApiError(`Invalid ${name}[${index}] in Ollama response.`);
      }
      // Old payloads used `name`, the current cloud API uses `model`.
      const modelName = typeof item.model === 'string' ? item.model : item.name;
      if (typeof modelName !== 'string' || !modelName) {
        return [];
      }
      const requestCount = optionalNumber(item.request_count) ?? 0;
      const cost = optionalNumber(item.usage_usd);
      return [{
        name: modelName,
        request_count: requestCount,
        ...(cost === undefined ? {} : { usage_usd: cost }),
      }];
    });
  }

  // Some payloads use a dictionary keyed by model name.
  if (isRecord(value)) {
    return Object.entries(value).flatMap(([modelName, info]) => {
      if (!modelName) {
        return [];
      }
      const record = isRecord(info) ? info : {};
      const requestCount = optionalNumber(record.request_count) ?? 0;
      const cost = optionalNumber(record.usage_usd);
      return [{
        name: modelName,
        request_count: requestCount,
        ...(cost === undefined ? {} : { usage_usd: cost }),
      }];
    });
  }

  throw new UsageApiError(`Invalid ${name} in Ollama response.`);
}

function sumModels(buckets: Array<{ groups: ModelUsage[] }>): ModelUsage[] {
  const totals = new Map<string, ModelUsage>();
  for (const bucket of buckets) {
    for (const model of bucket.groups) {
      const existing = totals.get(model.name);
      if (existing) {
        existing.request_count += model.request_count;
        if (model.usage_usd !== undefined) {
          existing.usage_usd = (existing.usage_usd ?? 0) + model.usage_usd;
        }
      } else {
        totals.set(model.name, { ...model });
      }
    }
  }

  return [...totals.values()].sort((a, b) => b.request_count - a.request_count);
}

export interface ParsedBalance {
  plan: 'legacy' | 'credits';
  session?: {
    usage: number;
    resets_at: string;
  };
  weekly?: {
    usage: number;
    resets_at: string;
  };
  credits?: {
    usage: number;
    balance_usd: number;
    allowance_usd: number;
    period: {
      from: string;
      until: string;
    };
    purchased_usd?: number;
  };
}

export interface ParsedCloudUsage {
  range?: string;
  from?: string;
  until?: string;
  totals?: {
    request_count: number;
    usage_usd?: number;
    groups: ModelUsage[];
  };
  buckets: Array<{
    from: string;
    until: string;
    groups: ModelUsage[];
  }>;
  limits?: {
    session?: {
      usage: number;
      resets_at?: string;
      models: ModelUsage[];
    };
    weekly?: {
      usage: number;
      resets_at?: string;
      models: ModelUsage[];
    };
  };
  activity?: {
    cost_usd: number;
    from?: string;
    until?: string;
    models: ModelUsage[];
  };
}

function parseLegacyWindow(value: unknown, name: string): { usage: number; resets_at: string } {
  const record = asRecord(value, name);
  const remainingPercent = asNumber(record.remaining_percent, `${name}.remaining_percent`);
  return {
    usage: usedFromRemaining(remainingPercent),
    resets_at: asString(record.resets_at, `${name}.resets_at`),
  };
}

/**
 * Parse `GET /api/balance`.
 *
 * Legacy plan:
 *   { included: { session: { remaining_percent, resets_at }, weekly: {...} }, purchased?: { balance_usd } }
 * Credit plan:
 *   { included: { balance_usd, allowance_usd, period: { from, until } }, purchased?: { balance_usd } }
 */
export function parseBalance(value: unknown): ParsedBalance {
  const response = asRecord(value, 'response');
  const included = asRecord(response.included, 'included');
  const purchased = isRecord(response.purchased) ? response.purchased : undefined;
  const purchasedUsd = purchased?.balance_usd === undefined
    ? undefined
    : asNumber(purchased.balance_usd, 'purchased.balance_usd');

  if (included.session !== undefined || included.weekly !== undefined) {
    if (included.session === undefined || included.weekly === undefined) {
      throw new UsageApiError('Invalid included in Ollama balance response.');
    }
    return {
      plan: 'legacy',
      session: parseLegacyWindow(included.session, 'included.session'),
      weekly: parseLegacyWindow(included.weekly, 'included.weekly'),
    };
  }

  if (included.balance_usd !== undefined && included.allowance_usd !== undefined) {
    const period = asRecord(included.period, 'included.period');
    const balanceUsd = asNumber(included.balance_usd, 'included.balance_usd');
    const allowanceUsd = asNumber(included.allowance_usd, 'included.allowance_usd');
    return {
      plan: 'credits',
      credits: {
        usage: allowanceUsd > 0 ? clampFraction(1 - balanceUsd / allowanceUsd) : 0,
        balance_usd: balanceUsd,
        allowance_usd: allowanceUsd,
        period: {
          from: asString(period.from, 'included.period.from'),
          until: asString(period.until, 'included.period.until'),
        },
        ...(purchasedUsd === undefined ? {} : { purchased_usd: purchasedUsd }),
      },
    };
  }

  throw new UsageApiError('Invalid included in Ollama balance response.');
}

function parseLimits(value: unknown): ParsedCloudUsage['limits'] {
  if (!isRecord(value)) {
    return undefined;
  }

  const parseOne = (raw: unknown, name: string) => {
    if (!isRecord(raw)) {
      return undefined;
    }
    return {
      usage: clampFraction(asNumber(raw.usage, `${name}.usage`)),
      resets_at: optionalString(raw.resets_at),
      models: parseModels(raw.models, `${name}.models`),
    };
  };

  const session = parseOne(value.session, 'limits.session');
  const weekly = parseOne(value.weekly, 'limits.weekly');
  return session || weekly ? { ...(session ? { session } : {}), ...(weekly ? { weekly } : {}) } : undefined;
}

function parseActivity(value: unknown): ParsedCloudUsage['activity'] {
  if (!isRecord(value)) {
    return undefined;
  }

  const period = isRecord(value.period) ? value.period : {};
  return {
    cost_usd: asNumber(value.cost, 'activity.cost'),
    from: optionalString(period.starting_at),
    until: optionalString(period.ending_at),
    models: parseModels(value.models, 'activity.models'),
  };
}

/**
 * Parse `GET /api/usage`.
 *
 * Current response is a time series: `range`, `scope`, `granularity`, `from`,
 * `until`, `totals` and `buckets`. With `group_by=model`, `totals.groups` and
 * each bucket's `groups` contain `{ model, request_count, usage_usd, ... }`.
 * Older responses exposed `limits` / `activity`; both are still accepted.
 */
export function parseCloudUsage(value: unknown): ParsedCloudUsage {
  const response = asRecord(value, 'response');

  const totalsRecord = isRecord(response.totals) ? response.totals : undefined;
  const totals = totalsRecord
    ? {
        request_count: optionalNumber(totalsRecord.request_count) ?? 0,
        usage_usd: optionalNumber(totalsRecord.usage_usd),
        groups: parseModels(totalsRecord.groups, 'totals.groups'),
      }
    : undefined;

  const buckets = Array.isArray(response.buckets)
    ? response.buckets.flatMap((bucket, index) => {
        if (!isRecord(bucket)) {
          throw new UsageApiError(`Invalid buckets[${index}] in Ollama response.`);
        }
        const from = optionalString(bucket.from);
        const until = optionalString(bucket.until);
        if (from === undefined || until === undefined) {
          return [];
        }
        return [{ from, until, groups: parseModels(bucket.groups, `buckets[${index}].groups`) }];
      })
    : [];

  const limits = parseLimits(response.limits);
  const activity = parseActivity(response.activity);

  if (!totals && !limits && !activity) {
    throw new UsageApiError('Invalid Ollama usage response.');
  }

  return {
    range: optionalString(response.range),
    from: optionalString(response.from),
    until: optionalString(response.until),
    ...(totals ? { totals } : {}),
    buckets,
    ...(limits ? { limits } : {}),
    ...(activity ? { activity } : {}),
  };
}

function sumModelsInWindow(usage: ParsedCloudUsage | undefined, startMs: number): ModelUsage[] {
  if (!usage) {
    return [];
  }

  if (Number.isFinite(startMs)) {
    const buckets = usage.buckets.filter((bucket) => {
      const bucketStart = Date.parse(bucket.from);
      return Number.isFinite(bucketStart) && bucketStart >= startMs;
    });
    if (buckets.length) {
      const summed = sumModels(buckets);
      if (summed.length) {
        return summed;
      }
    }
  }

  return usage.totals?.groups ?? [];
}

function spendFrom(usage: ParsedCloudUsage | undefined): SpendUsage | undefined {
  if (!usage) {
    return undefined;
  }

  if (usage.totals) {
    return {
      range: usage.range ?? '7d',
      from: usage.from ?? '',
      until: usage.until ?? '',
      ...(usage.totals.usage_usd === undefined ? {} : { cost_usd: usage.totals.usage_usd }),
      request_count: usage.totals.request_count,
      models: usage.totals.groups,
    };
  }

  if (usage.activity) {
    return {
      range: 'last_4_weeks',
      from: usage.activity.from ?? '',
      until: usage.activity.until ?? '',
      cost_usd: usage.activity.cost_usd,
      request_count: usage.activity.models.reduce((sum, model) => sum + model.request_count, 0),
      models: usage.activity.models,
    };
  }

  return undefined;
}

/**
 * Merge `/api/balance` with model breakdowns from `/api/usage` requests.
 *
 * `recent` is the 24h grouped response (used to isolate the current 5h session
 * window from hourly buckets). `longRange` is the 7d grouped response for
 * legacy plans, or the 30d grouped response for credit plans.
 */
export function composeUsage(
  balance: ParsedBalance,
  recent?: ParsedCloudUsage,
  longRange?: ParsedCloudUsage,
): UsageResponse {
  const result: UsageResponse = { plan: balance.plan };

  if (balance.plan === 'legacy' && balance.session && balance.weekly) {
    const sessionStart = Date.parse(balance.session.resets_at) - SESSION_WINDOW_MS;
    const weeklyStart = Date.parse(balance.weekly.resets_at) - WEEK_MS;
    result.session = {
      usage: balance.session.usage,
      resets_at: balance.session.resets_at,
      models: recent?.limits?.session?.models?.length
        ? recent.limits.session.models
        : sumModelsInWindow(recent, sessionStart),
    };
    result.weekly = {
      usage: balance.weekly.usage,
      resets_at: balance.weekly.resets_at,
      models: longRange?.limits?.weekly?.models?.length
        ? longRange.limits.weekly.models
        : sumModelsInWindow(longRange, weeklyStart),
    };
  }

  if (balance.plan === 'credits' && balance.credits) {
    const periodStart = Date.parse(balance.credits.period.from);
    result.credits = {
      ...balance.credits,
      models: sumModelsInWindow(longRange, periodStart),
    };
  }

  const spend = spendFrom(longRange) ?? spendFrom(recent);
  if (spend) {
    result.spend = spend;
  }

  return result;
}

function normalizeAuthorization(apiKey: string): string {
  const key = apiKey.trim();
  return key.toLowerCase().startsWith('bearer ') ? key : `Bearer ${key}`;
}

function requestJson(url: string, apiKey: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const request = https.request(url, {
      headers: {
        Accept: 'application/json',
        Authorization: normalizeAuthorization(apiKey),
      },
    }, (response) => {
      let size = 0;
      let body = '';

      response.setEncoding('utf8');
      response.on('data', (chunk: string) => {
        size += Buffer.byteLength(chunk);
        if (size > MAX_RESPONSE_BYTES) {
          response.destroy(new UsageApiError('Ollama response is too large.'));
          return;
        }
        body += chunk;
      });
      response.on('error', reject);
      response.on('end', () => {
        if (response.statusCode !== 200) {
          let message = `Ollama returned HTTP ${response.statusCode ?? 'unknown'}.`;
          try {
            const parsed: unknown = JSON.parse(body);
            if (isRecord(parsed) && typeof parsed.error === 'string') {
              message = `Ollama: ${parsed.error} (HTTP ${response.statusCode}).`;
            }
          } catch {
            // Keep the status-only message for non-JSON error bodies.
          }
          reject(new UsageApiError(message));
          return;
        }

        try {
          resolve(JSON.parse(body));
        } catch (error) {
          reject(error instanceof Error ? error : new UsageApiError('Invalid Ollama response.'));
        }
      });
    });

    request.setTimeout(10_000, () => request.destroy(new UsageApiError('Ollama request timed out.')));
    request.on('error', reject);
    request.end();
  });
}

function tryParseCloudUsage(value: unknown): ParsedCloudUsage | undefined {
  try {
    return parseCloudUsage(value);
  } catch {
    // Model breakdowns are best-effort; quota data from /api/balance is enough.
    return undefined;
  }
}

export async function fetchUsage(apiKey: string): Promise<UsageResponse> {
  if (!apiKey.trim()) {
    throw new UsageApiError('Ollama API key is empty.');
  }

  const balance = parseBalance(await requestJson(BALANCE_URL, apiKey));

  // Credit plans report a monthly allowance, so use 30d; legacy plans use 7d
  // to match their weekly window.
  const longRange = balance.plan === 'credits' ? '30d' : '7d';
  const [recentResult, longResult] = await Promise.allSettled([
    requestJson(`${USAGE_URL}?range=24h&group_by=model`, apiKey),
    requestJson(`${USAGE_URL}?range=${longRange}&group_by=model`, apiKey),
  ]);

  const recent = recentResult.status === 'fulfilled' ? tryParseCloudUsage(recentResult.value) : undefined;
  const longUsage = longResult.status === 'fulfilled' ? tryParseCloudUsage(longResult.value) : undefined;

  return composeUsage(balance, recent, longUsage);
}
