import { validateEnv } from './env.validation';

describe('validateEnv', () => {
  it('accepts an empty env (defaults will be applied by ExpertConfigService)', () => {
    expect(() => validateEnv({})).not.toThrow();
  });

  it('accepts well-formed values for every optional var', () => {
    expect(() =>
      validateEnv({
        EXPERT_DOMAIN: 'sports',
        EXPERT_DESCRIPTION: 'You are a sports expert.',
        OFF_TOPIC_MESSAGE: 'Only sports.',
        APP_TITLE: 'Sports Expert',
        APP_SUBTITLE: 'online',
        EXPERT_TOOL_NAME: 'lookup_stats',
        EXPERT_TOOL_DESCRIPTION: 'Look up team or athlete stats.',
      }),
    ).not.toThrow();
  });

  it('rejects empty-string values for any expert/app var', () => {
    expect(() => validateEnv({ EXPERT_DOMAIN: '' })).toThrow(
      /EXPERT_DOMAIN must be a non-empty string/,
    );
    expect(() => validateEnv({ APP_TITLE: '   ' })).toThrow(
      /APP_TITLE must be a non-empty string/,
    );
  });

  it('rejects non-string values for expert/app vars', () => {
    expect(() => validateEnv({ EXPERT_DOMAIN: 42 })).toThrow(
      /EXPERT_DOMAIN must be a non-empty string/,
    );
  });

  it('rejects tool names that violate the provider identifier regex', () => {
    expect(() =>
      validateEnv({ EXPERT_TOOL_NAME: 'has spaces' }),
    ).toThrow(/EXPERT_TOOL_NAME must match/);
    expect(() =>
      validateEnv({ EXPERT_TOOL_NAME: 'too-long'.repeat(20) }),
    ).toThrow(/EXPERT_TOOL_NAME must match/);
  });

  it('accepts tool names that match the identifier regex', () => {
    expect(() =>
      validateEnv({ EXPERT_TOOL_NAME: 'lookup_stats' }),
    ).not.toThrow();
    expect(() =>
      validateEnv({ EXPERT_TOOL_NAME: 'run-ts-snippet' }),
    ).not.toThrow();
  });

  describe('production gating', () => {
    it('requires EXPERT_DOMAIN and EXPERT_DESCRIPTION in production', () => {
      expect(() => validateEnv({ NODE_ENV: 'production' })).toThrow(
        /EXPERT_DOMAIN is required in production/,
      );
      expect(() => validateEnv({ NODE_ENV: 'production' })).toThrow(
        /EXPERT_DESCRIPTION is required in production/,
      );
    });

    it('passes when prod has both required vars set', () => {
      expect(() =>
        validateEnv({
          NODE_ENV: 'production',
          EXPERT_DOMAIN: 'sports',
          EXPERT_DESCRIPTION: 'You are a sports expert.',
        }),
      ).not.toThrow();
    });

    it('aggregates multiple errors into a single throw', () => {
      try {
        validateEnv({
          NODE_ENV: 'production',
          EXPERT_TOOL_NAME: 'bad name',
        });
        fail('expected throw');
      } catch (err) {
        const msg = (err as Error).message;
        expect(msg).toContain('EXPERT_DOMAIN is required');
        expect(msg).toContain('EXPERT_DESCRIPTION is required');
        expect(msg).toContain('EXPERT_TOOL_NAME must match');
      }
    });
  });
});
