import { ConfigService } from '@nestjs/config';
import { ExpertConfigService } from './expert-config.service';

function build(env: Record<string, string | undefined>): ExpertConfigService {
  // Minimal ConfigService stub: ConfigService#get(key) reads from process.env
  // in production, but we just route through the in-memory map.
  const cfg = {
    get: <T = string>(key: string): T | undefined => env[key] as T | undefined,
  } as unknown as ConfigService;
  return new ExpertConfigService(cfg);
}

describe('ExpertConfigService', () => {
  describe('defaults (no env set)', () => {
    const svc = build({});

    it('returns the original TypeScript persona for every getter', () => {
      expect(svc.domain).toBe('TypeScript and JavaScript');
      expect(svc.description).toMatch(/senior TypeScript engineer/);
      expect(svc.offTopicMessage).toMatch(/TypeScript coding expert/);
      expect(svc.appTitle).toBe('TypeScript Coding Expert');
      expect(svc.appSubtitle).toMatch(/ask TS \/ JS/);
      expect(svc.toolName).toBe('run_ts_snippet');
      expect(svc.toolDescription).toMatch(/TypeScript snippet/);
    });

    it('buildSystemPrompt includes the default domain and tool name', () => {
      const p = svc.buildSystemPrompt();
      expect(p).toContain('TypeScript and JavaScript');
      expect(p).toContain('run_ts_snippet');
      expect(p).toMatch(/Only answer questions related to/);
      expect(p).toMatch(/refuse with:/);
    });

    it('snapshot() returns the whitelisted shape with defaults', () => {
      expect(svc.snapshot()).toEqual({
        domain: 'TypeScript and JavaScript',
        description: expect.stringMatching(/senior TypeScript engineer/),
        offTopicMessage: expect.stringMatching(/TypeScript coding expert/),
        appTitle: 'TypeScript Coding Expert',
        appSubtitle: expect.stringMatching(/ask TS \/ JS/),
        tool: {
          name: 'run_ts_snippet',
          description: expect.stringMatching(/TypeScript snippet/),
        },
      });
    });
  });

  describe('env overrides', () => {
    const svc = build({
      EXPERT_DOMAIN: 'sports',
      EXPERT_DESCRIPTION: 'You are a sports expert assistant.',
      OFF_TOPIC_MESSAGE: 'I can only answer questions related to sports.',
      APP_TITLE: 'Sports Expert',
      APP_SUBTITLE: 'online \u00b7 ask anything about sports',
      EXPERT_TOOL_NAME: 'lookup_stats',
      EXPERT_TOOL_DESCRIPTION: 'Look up athlete or team statistics.',
    });

    it('every getter reflects the overridden value', () => {
      expect(svc.domain).toBe('sports');
      expect(svc.description).toBe('You are a sports expert assistant.');
      expect(svc.offTopicMessage).toBe(
        'I can only answer questions related to sports.',
      );
      expect(svc.appTitle).toBe('Sports Expert');
      expect(svc.toolName).toBe('lookup_stats');
      expect(svc.toolDescription).toBe('Look up athlete or team statistics.');
    });

    it('buildSystemPrompt interpolates the configured domain + refusal + tool', () => {
      const p = svc.buildSystemPrompt();
      expect(p).toContain('You are a sports expert assistant.');
      expect(p).toContain('Only answer questions related to sports.');
      expect(p).toContain(
        '"I can only answer questions related to sports."',
      );
      expect(p).toContain('lookup_stats');
      expect(p).not.toMatch(/TypeScript/);
    });

    it('snapshot returns the overridden values', () => {
      expect(svc.snapshot()).toEqual({
        domain: 'sports',
        description: 'You are a sports expert assistant.',
        offTopicMessage: 'I can only answer questions related to sports.',
        appTitle: 'Sports Expert',
        appSubtitle: 'online \u00b7 ask anything about sports',
        tool: {
          name: 'lookup_stats',
          description: 'Look up athlete or team statistics.',
        },
      });
    });
  });
});
