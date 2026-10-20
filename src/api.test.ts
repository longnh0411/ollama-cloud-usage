import assert from 'node:assert/strict';
import test from 'node:test';
import { composeUsage, parseBalance, parseCloudUsage, UsageApiError } from './api';

const LEGACY_BALANCE = {
  included: {
    session: { remaining_percent: 75, resets_at: '2026-10-20T12:00:00Z' },
    weekly: { remaining_percent: 40, resets_at: '2026-10-26T00:00:00Z' },
  },
  purchased: { balance_usd: 25 },
};

const CREDIT_BALANCE = {
  included: {
    balance_usd: 72.5,
    allowance_usd: 100,
    period: { from: '2026-09-15T09:30:00Z', until: '2026-10-15T09:30:00Z' },
  },
  purchased: { balance_usd: 25 },
};

const USAGE_24H = {
  range: '24h',
  scope: 'self',
  granularity: 'hour',
  group_by: 'model',
  from: '2026-10-19T12:00:00Z',
  until: '2026-10-20T12:00:00Z',
  totals: {
    request_count: 30,
    usage_usd: 0.03,
    groups: [{ model: 'glm-5.3', request_count: 30, usage_usd: 0.03 }],
  },
  buckets: [
    {
      from: '2026-10-19T20:00:00Z',
      until: '2026-10-19T21:00:00Z',
      request_count: 10,
      groups: [{ model: 'glm-5.3', request_count: 10 }],
    },
    {
      from: '2026-10-20T08:00:00Z',
      until: '2026-10-20T09:00:00Z',
      partial: true,
      request_count: 20,
      groups: [{ model: 'gpt-oss:120b', request_count: 20 }],
    },
  ],
};

const USAGE_7D = {
  range: '7d',
  scope: 'self',
  granularity: 'day',
  group_by: 'model',
  from: '2026-10-13T00:00:00Z',
  until: '2026-10-20T12:00:00Z',
  totals: {
    request_count: 50,
    usage_usd: 0.5,
    groups: [{ model: 'glm-5.3', request_count: 50, usage_usd: 0.5 }],
  },
  buckets: [
    {
      from: '2026-10-19T00:00:00Z',
      until: '2026-10-20T00:00:00Z',
      request_count: 50,
      groups: [{ model: 'glm-5.3', request_count: 50 }],
    },
  ],
};

test('parses legacy balance windows as used fractions', () => {
  assert.deepEqual(parseBalance(LEGACY_BALANCE), {
    plan: 'legacy',
    session: { usage: 0.25, resets_at: '2026-10-20T12:00:00Z' },
    weekly: { usage: 0.6, resets_at: '2026-10-26T00:00:00Z' },
  });
});

test('parses credit balance', () => {
  assert.deepEqual(parseBalance(CREDIT_BALANCE), {
    plan: 'credits',
    credits: {
      usage: 0.275,
      balance_usd: 72.5,
      allowance_usd: 100,
      period: { from: '2026-09-15T09:30:00Z', until: '2026-10-15T09:30:00Z' },
      purchased_usd: 25,
    },
  });
});

test('parses time-series usage response with model groups', () => {
  const parsed = parseCloudUsage(USAGE_24H);

  assert.equal(parsed.range, '24h');
  assert.deepEqual(parsed.totals, {
    request_count: 30,
    usage_usd: 0.03,
    groups: [{ name: 'glm-5.3', request_count: 30, usage_usd: 0.03 }],
  });
  assert.equal(parsed.buckets.length, 2);
  assert.deepEqual(parsed.buckets[1].groups, [{ name: 'gpt-oss:120b', request_count: 20 }]);
});

test('still accepts the old limits/activity shape', () => {
  const parsed = parseCloudUsage({
    activity: {
      cost: '0.00000',
      period: {
        type: 'last_4_weeks',
        starting_at: '2026-07-06T00:00:00Z',
        ending_at: '2026-07-31T01:55:05.109801096Z',
      },
      models: [],
    },
    limits: {
      session: { usage: 0, models: [] },
      weekly: { usage: 0.34, models: [{ name: 'glm-5.2', request_count: 740 }] },
    },
  });

  assert.equal(parsed.limits?.weekly?.usage, 0.34);
  assert.deepEqual(parsed.limits?.weekly?.models, [{ name: 'glm-5.2', request_count: 740 }]);
  assert.equal(parsed.activity?.cost_usd, 0);
});

test('composes legacy usage, isolating session models to the current 5h window', () => {
  const usage = composeUsage(
    parseBalance(LEGACY_BALANCE),
    parseCloudUsage(USAGE_24H),
    parseCloudUsage(USAGE_7D),
  );

  assert.equal(usage.plan, 'legacy');
  assert.equal(usage.session?.usage, 0.25);
  assert.equal(usage.session?.resets_at, '2026-10-20T12:00:00Z');
  assert.deepEqual(usage.session?.models, [{ name: 'gpt-oss:120b', request_count: 20 }]);
  assert.equal(usage.weekly?.usage, 0.6);
  assert.deepEqual(usage.weekly?.models, [{ name: 'glm-5.3', request_count: 50 }]);
  assert.deepEqual(usage.spend, {
    range: '7d',
    from: '2026-10-13T00:00:00Z',
    until: '2026-10-20T12:00:00Z',
    cost_usd: 0.5,
    request_count: 50,
    models: [{ name: 'glm-5.3', request_count: 50, usage_usd: 0.5 }],
  });
});

test('composes credit usage with model breakdown', () => {
  const usage = composeUsage(parseBalance(CREDIT_BALANCE), undefined, parseCloudUsage(USAGE_7D));

  assert.equal(usage.plan, 'credits');
  assert.equal(usage.credits?.usage, 0.275);
  assert.equal(usage.credits?.purchased_usd, 25);
  assert.deepEqual(usage.credits?.models, [{ name: 'glm-5.3', request_count: 50 }]);
});

test('omits spend cost when the API does not report usage_usd', () => {
  const noCostUsage = {
    range: '24h',
    from: '2026-10-19T10:00:00Z',
    until: '2026-10-20T10:09:58.476881712Z',
    totals: {
      request_count: 5,
      groups: [{ model: 'glm-5.3-flash', request_count: 5 }],
    },
    buckets: [],
  };

  const parsed = parseCloudUsage(noCostUsage);
  const usage = composeUsage(parseBalance(LEGACY_BALANCE), parsed, parsed);

  assert.equal(usage.spend?.request_count, 5);
  assert.equal(usage.spend?.cost_usd, undefined);
  assert.deepEqual(usage.spend?.models, [{ name: 'glm-5.3-flash', request_count: 5 }]);
});

test('rejects malformed balance response', () => {
  assert.throws(() => parseBalance({}), UsageApiError);
});

test('rejects malformed usage response', () => {
  assert.throws(() => parseCloudUsage({}), UsageApiError);
});
