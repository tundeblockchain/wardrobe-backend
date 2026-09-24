export interface AppConfig {
  stage: string;
  githubOwner?: string;
  githubRepo?: string;
  githubBranch: string;
  connectionArn?: string;
  supportContactAllowedOrigins?: string;
  supportContactRateLimit?: string;
  supportContactRateWindowSeconds?: string;
}

interface ContextReader {
  tryGetContext(key: string): unknown;
}

function readString(
  node: ContextReader,
  contextKey: string,
  envValue: string | undefined,
  fallback?: string,
): string | undefined {
  const fromContext = node.tryGetContext(contextKey);
  if (typeof fromContext === 'string' && fromContext.trim().length > 0) {
    return fromContext.trim();
  }
  if (envValue && envValue.trim().length > 0) {
    return envValue.trim();
  }
  return fallback;
}

export function resolveAppConfig(node: ContextReader): AppConfig {
  return {
    stage: readString(node, 'stage', process.env.STAGE, 'dev') ?? 'dev',
    githubOwner: readString(node, 'githubOwner', process.env.GITHUB_OWNER),
    githubRepo: readString(node, 'githubRepo', process.env.GITHUB_REPO),
    githubBranch:
      readString(node, 'githubBranch', process.env.GITHUB_BRANCH, 'master') ??
      'master',
    connectionArn: readString(
      node,
      'connectionArn',
      process.env.CODESTAR_CONNECTION_ARN,
    ),
    supportContactAllowedOrigins: readString(
      node,
      'supportContactAllowedOrigins',
      process.env.SUPPORT_CONTACT_ALLOWED_ORIGINS,
    ),
    supportContactRateLimit: readString(
      node,
      'supportContactRateLimit',
      process.env.SUPPORT_CONTACT_RATE_LIMIT,
    ),
    supportContactRateWindowSeconds: readString(
      node,
      'supportContactRateWindowSeconds',
      process.env.SUPPORT_CONTACT_RATE_WINDOW_SECONDS,
    ),
  };
}

export function isCiEnvironment(): boolean {
  return Boolean(process.env.CI || process.env.CODEBUILD_BUILD_ID);
}

export function hasPipelineSource(config: AppConfig): boolean {
  return Boolean(config.githubOwner && config.githubRepo && config.connectionArn);
}
