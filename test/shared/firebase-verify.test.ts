import { parseFirebaseProjectId } from '../../src/shared/firebase-verify';

describe('parseFirebaseProjectId', () => {
  it('accepts a raw project id', () => {
    expect(parseFirebaseProjectId('  demo-project  ')).toBe('demo-project');
  });

  it('accepts JSON { projectId }', () => {
    expect(parseFirebaseProjectId(JSON.stringify({ projectId: 'from-json' }))).toBe(
      'from-json',
    );
  });

  it('rejects an empty secret', () => {
    expect(() => parseFirebaseProjectId('')).toThrow('empty');
    expect(() => parseFirebaseProjectId(undefined)).toThrow('empty');
  });
});
