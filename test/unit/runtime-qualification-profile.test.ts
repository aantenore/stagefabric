import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';
import { stringify } from 'yaml';

import {
  MAX_RUNTIME_QUALIFICATION_PROFILE_BYTES,
  parseRuntimeQualificationProfile,
  RuntimeQualificationProfileError,
} from '../../src/adapters/runtime-qualification-profile.js';
import { RUNTIME_QUALIFICATION_LIMITS } from '../../src/domain/runtime-qualification.js';

function profile() {
  return {
    apiVersion: 'stagefabric.dev/v1alpha1',
    kind: 'RuntimeQualificationProfile',
    limits: {
      totalTimeoutMs: 60_000,
      maxConcurrency: 1,
      maxTargets: 1,
      maxOperations: 2,
      maxGenerationOutputTokensPerCall: 512,
    },
    targets: [{ targetId: 'ollama-local', operations: ['embed', 'generate'] }],
  };
}

describe('runtime qualification profile codec', () => {
  it('keeps the checked-in explicit Ollama profile parseable', () => {
    expect(
      parseRuntimeQualificationProfile(
        readFileSync(
          resolve('examples/runtime-qualification.ollama.yaml'),
          'utf8',
        ),
      ),
    ).toEqual(profile());
  });

  it('rejects prompts, executable selectors, aliases, and duplicate keys', () => {
    for (const extra of [
      { prompt: 'do something arbitrary' },
      { module: './custom-qualifier.js' },
      { command: 'node arbitrary.js' },
    ]) {
      expect(() =>
        parseRuntimeQualificationProfile(stringify({ ...profile(), ...extra })),
      ).toThrowError(
        expect.objectContaining<Partial<RuntimeQualificationProfileError>>({
          code: 'qualification_profile_invalid',
        }),
      );
    }
    expect(() =>
      parseRuntimeQualificationProfile(
        'limits: &limits {}\ntargets: []\ncopy: *limits\n',
      ),
    ).toThrowError(
      expect.objectContaining<Partial<RuntimeQualificationProfileError>>({
        code: 'qualification_profile_yaml_invalid',
      }),
    );
    expect(() =>
      parseRuntimeQualificationProfile(
        'apiVersion: a\napiVersion: b\nkind: RuntimeQualificationProfile\n',
      ),
    ).toThrowError(
      expect.objectContaining<Partial<RuntimeQualificationProfileError>>({
        code: 'qualification_profile_yaml_invalid',
      }),
    );
  });

  it('bounds profile bytes and keeps schema issues content-free', () => {
    expect(() =>
      parseRuntimeQualificationProfile(
        'x'.repeat(MAX_RUNTIME_QUALIFICATION_PROFILE_BYTES + 1),
      ),
    ).toThrowError(
      expect.objectContaining<Partial<RuntimeQualificationProfileError>>({
        code: 'qualification_profile_too_large',
      }),
    );

    const sentinel = 'profile-secret-sentinel';
    let caught: unknown;
    try {
      parseRuntimeQualificationProfile(
        stringify({ ...profile(), [sentinel]: true }),
      );
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(RuntimeQualificationProfileError);
    expect(JSON.stringify(caught)).not.toContain(sentinel);
  });

  it('bounds the per-call generation token budget', () => {
    expect(() =>
      parseRuntimeQualificationProfile(
        stringify({
          ...profile(),
          limits: {
            ...profile().limits,
            maxGenerationOutputTokensPerCall:
              RUNTIME_QUALIFICATION_LIMITS.maxGenerationOutputTokensPerCall
                .max + 1,
          },
        }),
      ),
    ).toThrowError(
      expect.objectContaining<Partial<RuntimeQualificationProfileError>>({
        code: 'qualification_profile_invalid',
      }),
    );
  });
});
