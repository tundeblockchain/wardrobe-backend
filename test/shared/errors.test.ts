import { Errors } from '../../src/shared/errors';

describe('user-facing error copy (WARDROBE-146)', () => {
  it('keeps AI_PROFILE_NOT_FOUND and uses Virtual Profile wording', () => {
    const error = Errors.aiProfileNotFound();

    expect(error.code).toBe('AI_PROFILE_NOT_FOUND');
    expect(error.statusCode).toBe(404);
    expect(error.message).toBe('Virtual Profile not found.');
  });

  it('keeps ENTITLEMENT_AI_REQUIRED and uses Virtual Try On wording', () => {
    const error = Errors.aiRequired();

    expect(error.code).toBe('ENTITLEMENT_AI_REQUIRED');
    expect(error.statusCode).toBe(403);
    expect(error.message).toBe(
      'Virtual Try On and other AI features require Premium.',
    );
  });

  it('preserves error codes when a custom message is supplied', () => {
    expect(Errors.aiProfileNotFound('custom').code).toBe('AI_PROFILE_NOT_FOUND');
    expect(Errors.aiRequired('custom').code).toBe('ENTITLEMENT_AI_REQUIRED');
  });
});
