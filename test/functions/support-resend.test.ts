import {
  fetchReceivedEmail,
  RESEND_API_BASE,
  sendEmail,
} from '../../src/functions/support/resend';

describe('Resend HTTP client (WARDROBE-38)', () => {
  it('POSTs /emails with Bearer auth and never uses a live host in tests', async () => {
    const http = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ id: 'email_abc' }),
    });

    await expect(
      sendEmail(
        {
          apiKey: 're_test',
          from: 'support@example.test',
          to: 'tunde@example.test',
          subject: 'Hello',
          text: 'Body',
          replyTo: 'user@example.com',
          idempotencyKey: 'inbound:1',
        },
        http,
      ),
    ).resolves.toEqual({ id: 'email_abc' });

    expect(http).toHaveBeenCalledWith(`${RESEND_API_BASE}/emails`, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer re_test',
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'User-Agent': 'wardrobe-backend/support',
        'Idempotency-Key': 'inbound:1',
      },
      body: JSON.stringify({
        from: 'support@example.test',
        to: ['tunde@example.test'],
        subject: 'Hello',
        text: 'Body',
        reply_to: 'user@example.com',
      }),
    });
    expect(http.mock.calls[0][0]).toMatch(/^https:\/\/api\.resend\.com\//);
  });

  it('throws on a non-2xx send so handlers can 500 (Resend retries inbound)', async () => {
    const http = jest.fn().mockResolvedValue({
      ok: false,
      status: 429,
      text: async () => '{"message":"rate limited"}',
    });

    await expect(
      sendEmail(
        {
          apiKey: 're_test',
          from: 'support@example.test',
          to: 'tunde@example.test',
          subject: 'Hello',
          text: 'Body',
        },
        http,
      ),
    ).rejects.toThrow('Resend send HTTP 429');
  });

  it('GETs /emails/receiving/{id} and returns undefined on failure', async () => {
    const http = jest.fn().mockResolvedValue({
      ok: false,
      status: 404,
      text: async () => '',
    });

    await expect(fetchReceivedEmail('re_test', 'missing', http)).resolves.toBeUndefined();
    expect(http).toHaveBeenCalledWith(
      `${RESEND_API_BASE}/emails/receiving/missing`,
      expect.objectContaining({ method: 'GET' }),
    );
  });
});
