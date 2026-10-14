import {
  ensureStripeCustomer,
  stripeCustomerIdempotencyKey,
} from '../../src/shared/stripe-customer';
import { DynamoItem } from '../../src/shared/types';

const UID = 'firebase-uid-owner';

function profile(stripeCustomerId?: string): DynamoItem {
  return {
    PK: `USER#${UID}`,
    SK: 'PROFILE',
    entityType: 'PROFILE',
    userId: UID,
    createdAt: '2026-10-14T00:00:00.000Z',
    updatedAt: '2026-10-14T00:00:00.000Z',
    ...(stripeCustomerId ? { stripeCustomerId } : {}),
  };
}

describe('ensureStripeCustomer (WARDROBE-189)', () => {
  it('reuses a stored stripeCustomerId and does not call Stripe', async () => {
    const create = jest.fn();
    const persist = jest.fn();
    const id = await ensureStripeCustomer(UID, {
      getItem: async () => profile('cus_stored'),
      setStripeCustomerIdIfAbsent: persist,
      getStripeClient: async () => ({ customers: { create } }),
    });

    expect(id).toBe('cus_stored');
    expect(create).not.toHaveBeenCalled();
    expect(persist).not.toHaveBeenCalled();
  });

  it('creates a customer with uid metadata and a uid-derived idempotency key', async () => {
    const create = jest.fn().mockResolvedValue({ id: 'cus_new' });
    const persist = jest.fn().mockResolvedValue(true);
    const getItem = jest.fn().mockResolvedValue(undefined);
    const log = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };

    const id = await ensureStripeCustomer(UID, {
      getItem,
      setStripeCustomerIdIfAbsent: persist,
      getStripeClient: async () => ({ customers: { create } }),
      log,
    });

    expect(id).toBe('cus_new');
    expect(create).toHaveBeenCalledWith(
      { metadata: { uid: UID } },
      { idempotencyKey: stripeCustomerIdempotencyKey(UID) },
    );
    expect(stripeCustomerIdempotencyKey(UID)).toBe(`customer-create-${UID}`);
    expect(persist).toHaveBeenCalledWith(UID, 'cus_new');
    expect(JSON.stringify(log.info.mock.calls)).toContain('cus_new');
    expect(JSON.stringify(log.info.mock.calls)).not.toContain('sk_');
  });

  it('re-reads the stored id when the conditional write loses the race', async () => {
    const create = jest.fn().mockResolvedValue({ id: 'cus_loser' });
    const getItem = jest
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(profile('cus_winner'));

    const id = await ensureStripeCustomer(UID, {
      getItem,
      setStripeCustomerIdIfAbsent: async () => false,
      getStripeClient: async () => ({ customers: { create } }),
    });

    expect(id).toBe('cus_winner');
    expect(create).toHaveBeenCalledTimes(1);
    expect(getItem).toHaveBeenCalledTimes(2);
  });

  it('yields one customer id when two concurrent requests race', async () => {
    let stored: string | undefined;
    const create = jest.fn().mockImplementation(async () => ({ id: 'cus_shared' }));
    const getItem = jest.fn(async () =>
      stored ? profile(stored) : undefined,
    );
    const persist = jest.fn(async (_userId: string, customerId: string) => {
      if (stored) {
        return false;
      }
      stored = customerId;
      return true;
    });
    const deps = {
      getItem,
      setStripeCustomerIdIfAbsent: persist,
      getStripeClient: async () => ({ customers: { create } }),
    };

    const [first, second] = await Promise.all([
      ensureStripeCustomer(UID, deps),
      ensureStripeCustomer(UID, deps),
    ]);

    expect(first).toBe('cus_shared');
    expect(second).toBe('cus_shared');
    expect(new Set([first, second]).size).toBe(1);
    expect(create).toHaveBeenCalled();
    for (const call of create.mock.calls) {
      expect(call[1]).toEqual({ idempotencyKey: `customer-create-${UID}` });
    }
    expect(persist).toHaveBeenCalled();
    expect(stored).toBe('cus_shared');
  });
});
