/**
 * Schema validation for environment variables, wired into
 * `ConfigModule.forRoot({validate})` in AppModule.
 *
 * Runs once at boot, BEFORE any provider is instantiated. A misconfiguration
 * throws here and Nest aborts startup with a single, grouped error message
 * instead of failing later mid-request with cryptic upstream errors.
 *
 * Rules:
 *  - Every EXPERT_* / APP_* var is optional in development (defaults in
 *    ExpertConfigService preserve the TypeScript persona).
 *  - If set, each must be a non-empty trimmed string.
 *  - In production (NODE_ENV=production), EXPERT_DOMAIN and
 *    EXPERT_DESCRIPTION are REQUIRED — forces operators to make the
 *    persona explicit before going live.
 */

const OPTIONAL_STRING_VARS = [
  'EXPERT_DOMAIN',
  'EXPERT_DESCRIPTION',
  'OFF_TOPIC_MESSAGE',
  'APP_TITLE',
  'APP_SUBTITLE',
] as const;

const REQUIRED_IN_PROD = ['EXPERT_DOMAIN', 'EXPERT_DESCRIPTION'] as const;

export function validateEnv(
  raw: Record<string, unknown>,
): Record<string, unknown> {
  const errors: string[] = [];
  const isProd = raw.NODE_ENV === 'production';

  for (const key of OPTIONAL_STRING_VARS) {
    const v = raw[key];
    if (v === undefined) continue;
    if (typeof v !== 'string' || v.trim() === '') {
      errors.push(`${key} must be a non-empty string when set`);
    }
  }

  if (isProd) {
    for (const key of REQUIRED_IN_PROD) {
      const v = raw[key];
      if (typeof v !== 'string' || v.trim() === '') {
        errors.push(`${key} is required in production (NODE_ENV=production)`);
      }
    }
  }

  if (errors.length > 0) {
    throw new Error(
      `Invalid environment configuration:\n  - ${errors.join('\n  - ')}`,
    );
  }
  return raw;
}
