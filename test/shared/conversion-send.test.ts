import { createHash } from 'crypto';
import {
  CONVERSION_EVENT_RENEWED,
  CONVERSION_EVENT_START_TRIAL,
  CONVERSION_EVENT_SUBSCRIBE,
  ConversionEvent,
} from '../../src/shared/conversion-events';
import {
  buildMetaCapiPayload,
  buildTikTokEventsPayload,
  CONVERSION_MAX_ATTEMPTS,
  parseMetaCapiSecret,
  parseTikTokEventsSecret,
  resetConversionSecretCaches,
  sendConversionEvent,
} from '../../src/shared/conversion-send';

const UID = 'firebase-uid-owner';
const HASHED = createHash('sha256').update(UID, 'utf8').digest('hex');
const META_TOKEN = 'EAA_this_must_not_appear_in_logs';
const TIKTOK_TOKEN = 'tiktok_access_token_secret_value';
const SOURCE_URL = 'https://app.example/app/billing/success';
const USER_AGENT = 'Mozilla/5.0 WardrobeTest/1.0';

const subscribeEvent: ConversionEvent = {
  eventName: CONVERSION_EVENT_SUBSCRIBE,
  eventId: 'stripe_cs_1',
  eventTimeSeconds: 1_717_000_000,
  actionSource: 'system_generated',
  externalId: HASHED,
  eventSourceUrl: SOURCE_URL,
  value: 15,
  currency: 'GBP',
};

const checkoutWebsiteEvent: ConversionEvent = {
  ...subscribeEvent,
  actionSource: 'website',
  clientUserAgent: USER_AGENT,
  eventSourceUrl: SOURCE_URL,
};

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body),
  } as Response;
}

describe('conversion secret parsing (WARDROBE-249)', () => {
  it('parses Meta and TikTok JSON and optional testEventCode', () => {
    expect(
      parseMetaCapiSecret(
        JSON.stringify({
          pixelId: '1234567890',
          accessToken: 'token-meta',
          testEventCode: 'TEST12345',
        }),
      ),
    ).toEqual({
      id: '1234567890',
      accessToken: 'token-meta',
      testEventCode: 'TEST12345',
    });
    expect(
      parseTikTokEventsSecret(
        JSON.stringify({
          pixelCode: 'C1ABCD',
          accessToken: 'token-tt',
        }),
      ),
    ).toEqual({ id: 'C1ABCD', accessToken: 'token-tt' });
  });

  it('treats placeholders, missing fields, and raw strings as unusable', () => {
    expect(
      parseMetaCapiSecret(
        JSON.stringify({
          pixelId: 'placeholder',
          accessToken: 'placeholder',
        }),
      ),
    ).toBeUndefined();
    expect(
      parseTikTokEventsSecret(
        JSON.stringify({
          pixelCode: 'your-pixel-code',
          accessToken: 'changeme',
        }),
      ),
    ).toBeUndefined();
    expect(parseMetaCapiSecret('aws-generated-random-string')).toBeUndefined();
    expect(parseTikTokEventsSecret('{"pixelCode":"C1"}')).toBeUndefined();
  });
});

describe('platform payloads', () => {
  const events: ConversionEvent[] = [
    subscribeEvent,
    {
      ...subscribeEvent,
      eventName: CONVERSION_EVENT_START_TRIAL,
      eventId: 'sw_trial',
      actionSource: 'app',
      value: 0,
      currency: 'USD',
    },
    {
      ...subscribeEvent,
      eventName: CONVERSION_EVENT_RENEWED,
      eventId: 'stripe_in_1',
      value: 9.99,
      currency: 'USD',
    },
  ];

  it.each(events)(
    'builds Meta and TikTok payloads for $eventName without PII or raw ids',
    (event) => {
      const meta = buildMetaCapiPayload(event, 'TEST12345');
      const tiktok = buildTikTokEventsPayload(event, 'C1PIXEL', 'TEST12345');
      const serialized = JSON.stringify({ meta, tiktok });

      expect(serialized).not.toContain(UID);
      expect(serialized).not.toMatch(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
      expect(serialized).not.toContain('555-0100');
      expect(serialized).not.toContain('Jane');
      expect(JSON.stringify(meta)).toContain(HASHED);
      expect(JSON.stringify(tiktok)).toContain(HASHED);

      const metaBody = (meta.data as Array<Record<string, unknown>>)[0];
      expect(metaBody.event_name).toBe(event.eventName);
      expect(metaBody.event_id).toBe(event.eventId);
      expect(metaBody.action_source).toBe(event.actionSource);
      expect(meta.test_event_code).toBe('TEST12345');

      const ttBody = (tiktok.data as Array<Record<string, unknown>>)[0];
      expect(ttBody.event).toBe(event.eventName);
      expect(ttBody.event_id).toBe(event.eventId);
      expect(tiktok.event_source).toBe(
        event.actionSource === 'app' ? 'app' : 'web',
      );
      expect(tiktok.event_source_id).toBe('C1PIXEL');
      expect(tiktok.test_event_code).toBe('TEST12345');
      if (event.actionSource !== 'app') {
        expect(ttBody.page).toEqual({ url: SOURCE_URL });
        expect(JSON.stringify(ttBody)).not.toContain('"ip"');
      } else {
        expect(ttBody).not.toHaveProperty('page');
      }
    },
  );

  it('sends checkout Meta events as website with UA and event_source_url only', () => {
    const meta = buildMetaCapiPayload(checkoutWebsiteEvent);
    expect(meta).toEqual({
      data: [
        {
          event_name: CONVERSION_EVENT_SUBSCRIBE,
          event_time: 1_717_000_000,
          event_id: 'stripe_cs_1',
          action_source: 'website',
          event_source_url: SOURCE_URL,
          user_data: {
            external_id: HASHED,
            client_user_agent: USER_AGENT,
          },
          custom_data: { value: 15, currency: 'GBP' },
        },
      ],
    });
    const userData = (
      (meta.data as Array<Record<string, unknown>>)[0].user_data as Record<
        string,
        unknown
      >
    );
    expect(Object.keys(userData).sort()).toEqual([
      'client_user_agent',
      'external_id',
    ]);
  });

  it('sends invoice.paid / no-UA Meta events as system_generated without browser fields', () => {
    const meta = buildMetaCapiPayload(subscribeEvent);
    const metaBody = (meta.data as Array<Record<string, unknown>>)[0];
    const serialized = JSON.stringify(meta);

    expect(meta).toEqual({
      data: [
        {
          event_name: CONVERSION_EVENT_SUBSCRIBE,
          event_time: 1_717_000_000,
          event_id: 'stripe_cs_1',
          action_source: 'system_generated',
          user_data: { external_id: HASHED },
          custom_data: { value: 15, currency: 'GBP' },
        },
      ],
    });
    expect(metaBody).not.toHaveProperty('client_user_agent');
    expect(metaBody).not.toHaveProperty('event_source_url');
    expect(serialized).not.toContain('client_user_agent');
    expect(serialized).not.toContain('event_source_url');
    expect(serialized).not.toContain('"website"');
    expect(serialized).not.toContain(USER_AGENT);
  });

  it('sends TikTok web events with required page.url and no IP', () => {
    const tiktok = buildTikTokEventsPayload(checkoutWebsiteEvent, 'C1PIXEL');
    expect(tiktok).toEqual({
      event_source: 'web',
      event_source_id: 'C1PIXEL',
      data: [
        {
          event: CONVERSION_EVENT_SUBSCRIBE,
          event_time: 1_717_000_000,
          event_id: 'stripe_cs_1',
          user: {
            external_id: HASHED,
            user_agent: USER_AGENT,
          },
          page: { url: SOURCE_URL },
          properties: { value: 15, currency: 'GBP' },
        },
      ],
    });
    expect(JSON.stringify(tiktok)).not.toContain('"ip"');
    expect(JSON.stringify(tiktok)).not.toContain(UID);
  });
});

describe('sendConversionEvent', () => {
  const log = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
  const getSecretString = jest.fn();
  const sleep = jest.fn(async () => undefined);

  beforeEach(() => {
    jest.clearAllMocks();
    resetConversionSecretCaches();
    getSecretString.mockImplementation(async (arn: string) => {
      if (arn.includes('meta')) {
        return JSON.stringify({
          pixelId: '111',
          accessToken: META_TOKEN,
        });
      }
      return JSON.stringify({
        pixelCode: 'C1PIXEL',
        accessToken: TIKTOK_TOKEN,
      });
    });
  });

  function deps(fetchImpl: typeof fetch) {
    return {
      env: {
        META_CAPI_SECRET_ARN: 'arn:secret:meta-capi',
        TIKTOK_EVENTS_SECRET_ARN: 'arn:secret:tiktok-events',
      },
      getSecretString,
      fetchImpl,
      sleep,
      log,
    };
  }

  it('skips sending and logs info when the secret ARN is missing', async () => {
    const fetchImpl = jest.fn();
    await sendConversionEvent(subscribeEvent, {
      env: {},
      fetchImpl,
      log,
    });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(log.info).toHaveBeenCalledWith(
      'Skipping conversion; secret ARN is not set',
      expect.objectContaining({ platform: 'meta' }),
    );
    expect(log.info).toHaveBeenCalledWith(
      'Skipping conversion; secret ARN is not set',
      expect.objectContaining({ platform: 'tiktok' }),
    );
  });

  it('skips sending and logs info when the secret is still a placeholder', async () => {
    getSecretString.mockResolvedValue(
      JSON.stringify({ pixelId: 'placeholder', accessToken: 'placeholder' }),
    );
    const fetchImpl = jest.fn();
    await sendConversionEvent(
      subscribeEvent,
      deps(fetchImpl),
    );
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(log.info).toHaveBeenCalledWith(
      'Skipping conversion; secret is a placeholder or incomplete',
      expect.objectContaining({ platform: 'meta' }),
    );
  });

  it('retries retryable HTTP failures then gives up without throwing', async () => {
    const fetchImpl = jest
      .fn()
      .mockResolvedValue(jsonResponse(500, { error: { message: 'down' } }));

    await expect(
      sendConversionEvent(subscribeEvent, deps(fetchImpl)),
    ).resolves.toBeUndefined();

    expect(fetchImpl).toHaveBeenCalledTimes(CONVERSION_MAX_ATTEMPTS * 2);
    expect(sleep).toHaveBeenCalledWith(100);
    expect(sleep).not.toHaveBeenCalledWith(150);
    expect(log.warn).toHaveBeenCalledWith(
      'Conversion platform request failed',
      expect.objectContaining({
        platform: 'meta',
        eventId: 'stripe_cs_1',
        retryable: true,
        status: 500,
      }),
    );
    const serialized = JSON.stringify({
      info: log.info.mock.calls,
      warn: log.warn.mock.calls,
      error: log.error.mock.calls,
    });
    expect(serialized).not.toContain(META_TOKEN);
    expect(serialized).not.toContain(TIKTOK_TOKEN);
    expect(serialized).not.toContain(UID);
    expect(serialized).not.toContain('EAA_');
  });

  it('does not retry a 400 and still sends the other platform', async () => {
    const fetchImpl = jest.fn().mockImplementation(async (url: string) => {
      if (String(url).includes('graph.facebook.com')) {
        return jsonResponse(400, { error: { message: 'bad' } });
      }
      return jsonResponse(200, { code: 0 });
    });

    await sendConversionEvent(subscribeEvent, deps(fetchImpl));

    const metaCalls = fetchImpl.mock.calls.filter(([url]) =>
      String(url).includes('graph.facebook.com'),
    );
    const tiktokCalls = fetchImpl.mock.calls.filter(([url]) =>
      String(url).includes('tiktok.com'),
    );
    expect(metaCalls).toHaveLength(1);
    expect(tiktokCalls).toHaveLength(1);
    expect(log.error).toHaveBeenCalledWith(
      'Conversion platform request failed',
      expect.objectContaining({
        platform: 'meta',
        status: 400,
        retryable: false,
      }),
    );
    expect(log.info).toHaveBeenCalledWith(
      'Conversion event sent',
      expect.objectContaining({ platform: 'tiktok', eventId: 'stripe_cs_1' }),
    );
  });

  it('skips Meta CAPI for app-sourced events and still sends TikTok', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(jsonResponse(200, { code: 0 }));
    await sendConversionEvent(
      {
        ...subscribeEvent,
        actionSource: 'app',
        eventId: 'sw_app_1',
      },
      deps(fetchImpl),
    );

    const metaCalls = fetchImpl.mock.calls.filter(([url]) =>
      String(url).includes('graph.facebook.com'),
    );
    const tiktokCalls = fetchImpl.mock.calls.filter(([url]) =>
      String(url).includes('tiktok.com'),
    );
    expect(metaCalls).toHaveLength(0);
    expect(tiktokCalls).toHaveLength(1);
    expect(log.info).toHaveBeenCalledWith(
      'Skipping Meta CAPI for app-sourced event; app SDK sends Meta',
      expect.objectContaining({ eventId: 'sw_app_1' }),
    );
  });

  it('logs a 4xx platform error code and does not retry', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(
      jsonResponse(400, { error: { message: 'Invalid parameter', code: 100 } }),
    );
    await sendConversionEvent(subscribeEvent, deps(fetchImpl));

    const metaCalls = fetchImpl.mock.calls.filter(([url]) =>
      String(url).includes('graph.facebook.com'),
    );
    expect(metaCalls).toHaveLength(1);
    expect(log.error).toHaveBeenCalledWith(
      'Conversion platform request failed',
      expect.objectContaining({
        platform: 'meta',
        status: 400,
        platformErrorCode: 100,
        retryable: false,
      }),
    );
    const serialized = JSON.stringify(log.error.mock.calls);
    expect(serialized).not.toContain(META_TOKEN);
    expect(serialized).not.toContain(UID);
  });

  it('is a no-op when the mapped event is undefined', async () => {
    const fetchImpl = jest.fn();
    await sendConversionEvent(undefined, deps(fetchImpl));
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(getSecretString).not.toHaveBeenCalled();
  });
});
