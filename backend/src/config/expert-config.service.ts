import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

/**
 * Snapshot served by GET /chat/config so the frontend can render labels
 * (page title, header, empty-state copy) without hardcoding any domain-
 * specific strings. Mirrored as `ExpertConfig` on the frontend.
 */
export interface ExpertConfigSnapshot {
  domain: string;
  description: string;
  offTopicMessage: string;
  appTitle: string;
  appSubtitle: string;
  tool: { name: string; description: string };
}

/**
 * Single source of truth for the assistant persona.
 *
 * Every "TypeScript expert" string the project used to hardcode lives here,
 * backed by env vars with safe defaults so existing tests and the
 * out-of-the-box developer experience stay unchanged. Override any of:
 *
 *   EXPERT_DOMAIN
 *   EXPERT_DESCRIPTION
 *   OFF_TOPIC_MESSAGE
 *   APP_TITLE
 *   APP_SUBTITLE
 *   EXPERT_TOOL_NAME
 *   EXPERT_TOOL_DESCRIPTION
 *
 * to repurpose the assistant for a different domain (sports, cooking,
 * physics, etc.) without code changes. See env.example for a worked
 * example.
 */
@Injectable()
export class ExpertConfigService {
  constructor(private readonly config: ConfigService) {}

  get domain(): string {
    return this.config.get<string>('EXPERT_DOMAIN') ?? 'TypeScript and JavaScript';
  }

  get description(): string {
    return (
      this.config.get<string>('EXPERT_DESCRIPTION') ??
      'You are a senior TypeScript engineer acting as a domain expert.'
    );
  }

  get offTopicMessage(): string {
    return (
      this.config.get<string>('OFF_TOPIC_MESSAGE') ??
      "I'm a TypeScript coding expert and can only help with TypeScript/JavaScript questions. Could you ask me something in that area?"
    );
  }

  get appTitle(): string {
    return this.config.get<string>('APP_TITLE') ?? 'TypeScript Coding Expert';
  }

  get appSubtitle(): string {
    return (
      this.config.get<string>('APP_SUBTITLE') ??
      'online \u00b7 ask TS / JS \u2014 try `run console.log(2+2)`'
    );
  }

  get toolName(): string {
    return this.config.get<string>('EXPERT_TOOL_NAME') ?? 'run_ts_snippet';
  }

  get toolDescription(): string {
    return (
      this.config.get<string>('EXPERT_TOOL_DESCRIPTION') ??
      'Statically analyze a short TypeScript snippet and return what it would print. ' +
        'Use ONLY for snippets the user explicitly asks you to "run" or "evaluate". ' +
        'Do not invoke for general explanation requests.'
    );
  }

  /**
   * Concatenated system prompt that LlmService passes to every provider.
   * Sections (Scope / Tools / Style) mirror the original hardcoded prompt;
   * only the per-domain phrases are interpolated.
   */
  buildSystemPrompt(): string {
    return [
      this.description,
      '',
      'Scope:',
      `- Only answer questions related to ${this.domain}.`,
      `- If the user asks something outside the domain, refuse with: "${this.offTopicMessage}". Do not attempt to answer off-topic questions even partially.`,
      '',
      'Tools:',
      `- You have a single tool, ${this.toolName}: ${this.toolDescription} Invoke it ONLY when the user explicitly asks you to "run", "execute" or "evaluate" a specific input. Do not invoke it just to illustrate explanations.`,
      '',
      'Style:',
      '- Be concise. Prefer code blocks for code examples.',
      '- When the user is wrong, correct them with a short, accurate explanation.',
    ].join('\n');
  }

  /**
   * Snapshot for GET /chat/config. Whitelists exactly the fields the
   * frontend cares about so internal config (LLM keys, base URLs, etc.)
   * can never leak through this endpoint.
   */
  snapshot(): ExpertConfigSnapshot {
    return {
      domain: this.domain,
      description: this.description,
      offTopicMessage: this.offTopicMessage,
      appTitle: this.appTitle,
      appSubtitle: this.appSubtitle,
      tool: { name: this.toolName, description: this.toolDescription },
    };
  }
}
