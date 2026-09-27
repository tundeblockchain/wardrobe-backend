const mockDeleteUser = jest.fn();
const mockGetAuth = jest.fn(() => ({ deleteUser: mockDeleteUser }));
const mockInitializeApp = jest.fn((..._args: unknown[]) => ({ name: 'test-app' }));
const mockGetApps = jest.fn(() => []);
const mockCert = jest.fn((value: unknown) => value);
const mockGetSecretString = jest.fn();

jest.mock('firebase-admin/app', () => ({
  cert: (value: unknown) => mockCert(value),
  getApps: () => mockGetApps(),
  initializeApp: (...args: unknown[]) => mockInitializeApp(...args),
}));

jest.mock('firebase-admin/auth', () => ({
  getAuth: () => mockGetAuth(),
}));

import {
  deleteFirebaseAuthUser,
  isFirebaseAuthUserNotFound,
  parseFirebaseAdminServiceAccount,
  resetFirebaseAdminApp,
} from '../../src/shared/firebase-admin-auth';

const SERVICE_ACCOUNT = {
  type: 'service_account',
  project_id: 'wardrobe-dev',
  client_email: 'firebase-admin@wardrobe-dev.iam.gserviceaccount.com',
  private_key: '-----BEGIN PRIVATE KEY-----\\nMIIEvQIBADANBg==\\n-----END PRIVATE KEY-----\\n',
};

describe('firebase-admin-auth (WARDROBE-154)', () => {
  const originalArn = process.env.FIREBASE_ADMIN_SECRET_ARN;

  beforeEach(() => {
    jest.clearAllMocks();
    resetFirebaseAdminApp();
    mockGetApps.mockReturnValue([]);
    process.env.FIREBASE_ADMIN_SECRET_ARN = 'arn:aws:secretsmanager:eu-west-1:1:secret:firebase-admin';
    mockGetSecretString.mockResolvedValue(JSON.stringify(SERVICE_ACCOUNT));
  });

  afterEach(() => {
    resetFirebaseAdminApp();
    if (originalArn === undefined) {
      delete process.env.FIREBASE_ADMIN_SECRET_ARN;
    } else {
      process.env.FIREBASE_ADMIN_SECRET_ARN = originalArn;
    }
  });

  describe('parseFirebaseAdminServiceAccount', () => {
    it('accepts standard Google service-account JSON', () => {
      expect(parseFirebaseAdminServiceAccount(JSON.stringify(SERVICE_ACCOUNT))).toEqual({
        projectId: 'wardrobe-dev',
        clientEmail: 'firebase-admin@wardrobe-dev.iam.gserviceaccount.com',
        privateKey:
          '-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBg==\n-----END PRIVATE KEY-----\n',
      });
    });

    it('accepts camelCase fields', () => {
      expect(
        parseFirebaseAdminServiceAccount(
          JSON.stringify({
            projectId: 'wardrobe-dev',
            clientEmail: 'admin@wardrobe-dev.iam.gserviceaccount.com',
            privateKey: '-----BEGIN PRIVATE KEY-----\\nabc\\n-----END PRIVATE KEY-----\\n',
          }),
        ),
      ).toEqual({
        projectId: 'wardrobe-dev',
        clientEmail: 'admin@wardrobe-dev.iam.gserviceaccount.com',
        privateKey: '-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----\n',
      });
    });

    it('rejects a placeholder or non-JSON secret', () => {
      expect(() => parseFirebaseAdminServiceAccount('not-json')).toThrow(
        /service-account JSON object/,
      );
      expect(() =>
        parseFirebaseAdminServiceAccount(
          JSON.stringify({
            project_id: 'your-firebase-project',
            client_email: 'your-service-account@example.com',
            private_key: '-----BEGIN PRIVATE KEY-----\\nabc\\n-----END PRIVATE KEY-----\\n',
          }),
        ),
      ).toThrow(/placeholder/);
    });
  });

  it('deletes the Auth user via firebase-admin auth().deleteUser', async () => {
    mockDeleteUser.mockResolvedValue(undefined);

    await deleteFirebaseAuthUser('firebase-uid-owner', {
      getSecretString: mockGetSecretString,
    });

    expect(mockInitializeApp).toHaveBeenCalled();
    expect(mockCert).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: 'wardrobe-dev',
        clientEmail: 'firebase-admin@wardrobe-dev.iam.gserviceaccount.com',
      }),
    );
    expect(mockDeleteUser).toHaveBeenCalledWith('firebase-uid-owner');
  });

  it('treats auth/user-not-found as success', async () => {
    const missing = new Error('There is no user record corresponding to the provided identifier.');
    (missing as { code?: string }).code = 'auth/user-not-found';
    mockDeleteUser.mockRejectedValue(missing);

    await expect(
      deleteFirebaseAuthUser('already-gone', {
        getSecretString: mockGetSecretString,
      }),
    ).resolves.toBeUndefined();

    expect(isFirebaseAuthUserNotFound(missing)).toBe(true);
  });

  it('rethrows other Auth errors', async () => {
    const down = new Error('credential');
    (down as { code?: string }).code = 'app/invalid-credential';
    mockDeleteUser.mockRejectedValue(down);

    await expect(
      deleteFirebaseAuthUser('firebase-uid-owner', {
        getSecretString: mockGetSecretString,
      }),
    ).rejects.toThrow('credential');
  });
});
