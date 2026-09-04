import { APIGatewayProxyEventV2 } from 'aws-lambda';
import { getUserId } from '../../src/shared/auth';
import { AppError } from '../../src/shared/errors';

function event(overrides: {
  sub?: string;
  userId?: string;
  bodyUserId?: string;
  jwtSub?: string;
}): APIGatewayProxyEventV2 {
  return {
    version: '2.0',
    routeKey: 'POST /wardrobes',
    rawPath: '/wardrobes',
    rawQueryString: '',
    headers: {},
    body: JSON.stringify({
      name: 'Summer Clothes',
      userId: overrides.bodyUserId ?? 'attacker-from-body',
    }),
    queryStringParameters: { userId: 'attacker-from-query' },
    pathParameters: { userId: 'attacker-from-path' },
    requestContext: {
      accountId: '123',
      apiId: 'api',
      domainName: 'example.com',
      domainPrefix: 'example',
      http: {
        method: 'POST',
        path: '/wardrobes',
        protocol: 'HTTP/1.1',
        sourceIp: '127.0.0.1',
        userAgent: 'jest',
      },
      requestId: 'req-1',
      routeKey: 'POST /wardrobes',
      stage: '$default',
      time: 'now',
      timeEpoch: 0,
      authorizer: {
        lambda: overrides.sub
          ? { sub: overrides.sub, userId: overrides.userId }
          : overrides.userId
            ? { userId: overrides.userId }
            : undefined,
        jwt: overrides.jwtSub
          ? { claims: { sub: overrides.jwtSub } }
          : undefined,
      },
    },
    isBase64Encoded: false,
  } as unknown as APIGatewayProxyEventV2;
}

describe('getUserId', () => {
  it('reads the Firebase UID from the Lambda authorizer context', () => {
    expect(getUserId(event({ sub: 'firebase-uid-real' }))).toBe(
      'firebase-uid-real',
    );
  });

  it('reads JWT claims sub when Lambda context is missing', () => {
    expect(getUserId(event({ jwtSub: 'jwt-uid' }))).toBe('jwt-uid');
  });

  it('throws UNAUTHENTICATED when authorizer context is missing', () => {
    expect(() => getUserId(event({}))).toThrow(AppError);
    try {
      getUserId(event({}));
    } catch (error) {
      const appError = error as AppError;
      expect(appError.code).toBe('UNAUTHENTICATED');
      expect(appError.statusCode).toBe(401);
    }
  });

  it('ignores body, query, and path userId even when they are present', () => {
    const spoofed = event({
      sub: 'token-uid',
      bodyUserId: 'attacker-from-body',
    });

    expect(getUserId(spoofed)).toBe('token-uid');
    expect(JSON.parse(spoofed.body ?? '{}').userId).toBe('attacker-from-body');
  });

  it('never treats a body userId as authenticated identity', () => {
    expect(() =>
      getUserId(event({ bodyUserId: 'only-in-body' })),
    ).toThrow(AppError);
  });
});
