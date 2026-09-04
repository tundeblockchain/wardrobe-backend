import { APIGatewayRequestAuthorizerEventV2 } from 'aws-lambda';
import { jwtVerify } from 'jose';

const mockSend = jest.fn();

jest.mock('@aws-sdk/client-secrets-manager', () => ({
  SecretsManagerClient: jest.fn(() => ({ send: mockSend })),
  GetSecretValueCommand: jest.fn().mockImplementation((input: unknown) => input),
}));

jest.mock('jose', () => ({
  createRemoteJWKSet: jest.fn(() => ({})),
  jwtVerify: jest.fn(),
}));

import {
  handler,
  resetAuthorizerCache,
} from '../../src/functions/authorizer/handler';

const jwtVerifyMock = jwtVerify as jest.MockedFunction<typeof jwtVerify>;

const PROJECT_ID = 'demo-firebase-project';
const SECRET_ARN =
  'arn:aws:secretsmanager:eu-west-1:123456789012:secret:wardrobe/dev/firebase-project-id';

function verifiedJwt(payload: Record<string, unknown>) {
  return {
    payload,
    protectedHeader: { alg: 'RS256' },
    key: {},
  } as unknown as Awaited<ReturnType<typeof jwtVerify>>;
}

function authorizerEvent(
  authorization?: string,
): APIGatewayRequestAuthorizerEventV2 {
  return {
    version: '2.0',
    type: 'REQUEST',
    routeArn: 'arn:aws:execute-api:eu-west-1:123456789012:api/$default/GET/wardrobes',
    identitySource: authorization ? [authorization] : [],
    routeKey: 'GET /wardrobes',
    rawPath: '/wardrobes',
    rawQueryString: '',
    cookies: [],
    headers: authorization ? { authorization } : {},
    requestContext: {
      accountId: '123456789012',
      apiId: 'api',
      domainName: 'example.execute-api.eu-west-1.amazonaws.com',
      domainPrefix: 'example',
      http: {
        method: 'GET',
        path: '/wardrobes',
        protocol: 'HTTP/1.1',
        sourceIp: '127.0.0.1',
        userAgent: 'jest',
      },
      requestId: 'req-1',
      routeKey: 'GET /wardrobes',
      stage: '$default',
      time: '01/Jan/2026:00:00:00 +0000',
      timeEpoch: 1_767_225_600_000,
    },
  };
}

describe('Firebase Lambda authorizer', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    resetAuthorizerCache();
    process.env.FIREBASE_PROJECT_ID_SECRET_ARN = SECRET_ARN;
    mockSend.mockResolvedValue({ SecretString: PROJECT_ID });
  });

  afterEach(() => {
    delete process.env.FIREBASE_PROJECT_ID_SECRET_ARN;
  });

  it('authorizes a valid token and exposes Firebase UID as sub', async () => {
    jwtVerifyMock.mockResolvedValue(
      verifiedJwt({ sub: 'firebase-uid-123', user_id: 'firebase-uid-123' }),
    );

    const result = await handler(authorizerEvent('Bearer valid.jwt.token'));

    expect(result).toEqual({
      isAuthorized: true,
      context: { sub: 'firebase-uid-123' },
    });
    expect(jwtVerifyMock).toHaveBeenCalledWith(
      'valid.jwt.token',
      expect.anything(),
      expect.objectContaining({
        issuer: `https://securetoken.google.com/${PROJECT_ID}`,
        audience: PROJECT_ID,
        algorithms: ['RS256'],
      }),
    );
    expect(mockSend).toHaveBeenCalled();
  });

  it('denies a missing Authorization header', async () => {
    const result = await handler(authorizerEvent());
    expect(result).toEqual({ isAuthorized: false, context: { sub: '' } });
    expect(jwtVerifyMock).not.toHaveBeenCalled();
  });

  it('denies a malformed Bearer token', async () => {
    const result = await handler(authorizerEvent('Basic not-a-jwt'));
    expect(result).toEqual({ isAuthorized: false, context: { sub: '' } });
    expect(jwtVerifyMock).not.toHaveBeenCalled();
  });

  it('denies when jwtVerify fails (invalid signature, wrong aud/iss, expired)', async () => {
    jwtVerifyMock.mockRejectedValue(new Error('JWTExpired'));

    const result = await handler(authorizerEvent('Bearer expired.jwt.token'));

    expect(result).toEqual({ isAuthorized: false, context: { sub: '' } });
  });

  it('denies when the token has an empty sub/uid', async () => {
    jwtVerifyMock.mockResolvedValue(verifiedJwt({ sub: '', user_id: '' }));

    const result = await handler(authorizerEvent('Bearer empty-sub.jwt.token'));

    expect(result).toEqual({ isAuthorized: false, context: { sub: '' } });
  });

  it('derives sub from Firebase user_id when sub is absent', async () => {
    jwtVerifyMock.mockResolvedValue(verifiedJwt({ user_id: 'uid-from-user-id' }));

    const result = await handler(authorizerEvent('Bearer uid.jwt.token'));

    expect(result).toEqual({
      isAuthorized: true,
      context: { sub: 'uid-from-user-id' },
    });
  });
});
