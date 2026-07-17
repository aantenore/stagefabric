import { describe, expect, it, vi } from 'vitest';

import {
  CapabilityAttestationVerificationError,
  createSigstoreCapabilitySnapshotAttestationVerifier,
  MAX_ATTESTATION_STATEMENT_BYTES,
  SIGSTORE_BUNDLE_V03_MEDIA_TYPE,
  type SigstoreVerifierFactory,
} from '../../src/adapters/sigstore-capability-snapshot-attestation-verifier.js';
import type { CapabilitySnapshotTrustPolicy } from '../../src/domain/capability-snapshot-attestation.js';
import { IN_TOTO_STATEMENT_PAYLOAD_TYPE } from '../../src/ports/capability-snapshot-attestation-verifier.js';

const digest = `sha256:${'0'.repeat(64)}` as const;

function policy(
  identity: CapabilitySnapshotTrustPolicy['signerIdentity'] = {
    type: 'uri',
    value:
      'https://github.com/aantenore/stagefabric/.github/workflows/qualify.yml@refs/heads/main?environment=[prod]',
  },
): CapabilitySnapshotTrustPolicy {
  return {
    apiVersion: 'stagefabric.dev/v1alpha1',
    kind: 'CapabilitySnapshotTrustPolicy',
    certificateIssuer: 'https://token.actions.githubusercontent.com',
    signerIdentity: identity,
    audience: 'stagefabric://control-plane/prod-eu',
    certificateThreshold: 2,
    transparencyLogThreshold: 3,
    fabricDigest: digest,
    qualificationProfileDigest: digest,
    maxSnapshotAgeSeconds: 60,
    maxSnapshotTtlSeconds: 120,
    clockSkewSeconds: 5,
  };
}

function bundle(payload = Buffer.from('{"ok":true}')): Uint8Array {
  return Buffer.from(
    JSON.stringify({
      mediaType: SIGSTORE_BUNDLE_V03_MEDIA_TYPE,
      verificationMaterial: {
        certificate: {
          rawBytes: Buffer.from('certificate').toString('base64'),
        },
        tlogEntries: [{}],
      },
      dsseEnvelope: {
        payloadType: IN_TOTO_STATEMENT_PAYLOAD_TYPE,
        payload: payload.toString('base64'),
        // sigstore-js omits an empty protobuf keyid in serialized bundles.
        signatures: [{ sig: 'signature' }],
      },
    }),
  );
}

describe('Sigstore capability snapshot attestation verifier', () => {
  it('pins a URI identity as an exact literal and returns authenticated bytes', async () => {
    const verify = vi.fn();
    const create = vi.fn(
      async (_options: Parameters<SigstoreVerifierFactory>[0]) => ({ verify }),
    );
    const trustPolicy = policy();
    const verifier = await createSigstoreCapabilitySnapshotAttestationVerifier(
      trustPolicy,
      { timeoutMs: 7_500 },
      create,
    );

    const result = await verifier.verify(bundle());

    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        certificateIssuer: trustPolicy.certificateIssuer,
        certificateIdentityURI:
          '^https://github\\.com/aantenore/stagefabric/\\.github/workflows/qualify\\.yml@refs/heads/main\\?environment=\\[prod\\]$',
        ctLogThreshold: 2,
        tlogThreshold: 3,
        timeout: 7_500,
      }),
    );
    expect(verify).toHaveBeenCalledOnce();
    expect(new TextDecoder().decode(result.payload)).toBe('{"ok":true}');
    expect(result.signer).toEqual({
      issuer: trustPolicy.certificateIssuer,
      identityType: 'uri',
      identity: trustPolicy.signerIdentity.value,
    });
  });

  it('uses the exact email policy branch', async () => {
    const create = vi.fn(
      async (_options: Parameters<SigstoreVerifierFactory>[0]) => ({
        verify: vi.fn(),
      }),
    );
    await createSigstoreCapabilitySnapshotAttestationVerifier(
      policy({ type: 'email', value: 'antonio+stage@example.com' }),
      {},
      create,
    );

    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        certificateIdentityEmail: '^antonio\\+stage@example\\.com$',
      }),
    );
    expect(create.mock.calls[0]?.[0]).not.toHaveProperty(
      'certificateIdentityURI',
    );
  });

  it('rejects a non-DSSE or wrong-payload bundle before signature verification', async () => {
    const verify = vi.fn();
    const verifier = await createSigstoreCapabilitySnapshotAttestationVerifier(
      policy(),
      {},
      async () => ({ verify }),
    );

    await expect(
      verifier.verify(
        Buffer.from(
          JSON.stringify({
            mediaType: SIGSTORE_BUNDLE_V03_MEDIA_TYPE,
            verificationMaterial: {
              certificate: {
                rawBytes: Buffer.from('certificate').toString('base64'),
              },
              tlogEntries: [{}],
            },
            dsseEnvelope: {
              payloadType: 'text/plain',
              payload: Buffer.from('{}').toString('base64'),
              signatures: [{ keyid: '', sig: 'signature' }],
            },
          }),
        ),
      ),
    ).rejects.toMatchObject({ code: 'attestation_bundle_invalid' });
    expect(verify).not.toHaveBeenCalled();
  });

  it('rejects protobuf oneof siblings before verifying or extracting payload', async () => {
    const verify = vi.fn();
    const verifier = await createSigstoreCapabilitySnapshotAttestationVerifier(
      policy(),
      {},
      async () => ({ verify }),
    );
    const mixedContent = JSON.parse(
      new TextDecoder().decode(bundle()),
    ) as Record<string, unknown>;
    mixedContent.messageSignature = {
      messageDigest: { algorithm: 'SHA2_256', digest: 'AA==' },
      signature: 'AA==',
    };

    await expect(
      verifier.verify(new TextEncoder().encode(JSON.stringify(mixedContent))),
    ).rejects.toMatchObject({ code: 'attestation_bundle_invalid' });

    const mixedMaterial = JSON.parse(new TextDecoder().decode(bundle())) as {
      verificationMaterial: Record<string, unknown>;
    };
    mixedMaterial.verificationMaterial.publicKey = { hint: 'untrusted-key' };
    await expect(
      verifier.verify(new TextEncoder().encode(JSON.stringify(mixedMaterial))),
    ).rejects.toMatchObject({ code: 'attestation_bundle_invalid' });
    expect(verify).not.toHaveBeenCalled();
  });

  it('normalizes verifier construction and signature failures', async () => {
    await expect(
      createSigstoreCapabilitySnapshotAttestationVerifier(
        policy(),
        {},
        async () => {
          throw new Error('raw trust-root failure');
        },
      ),
    ).rejects.toEqual(
      new CapabilityAttestationVerificationError(
        'sigstore_verifier_unavailable',
      ),
    );

    const verifier = await createSigstoreCapabilitySnapshotAttestationVerifier(
      policy(),
      {},
      async () => ({
        verify: () => {
          throw new Error('raw signature failure');
        },
      }),
    );
    await expect(verifier.verify(bundle())).rejects.toMatchObject({
      code: 'attestation_signature_invalid',
      message: 'attestation_signature_invalid',
    });
  });

  it('keeps the preverified payload stable when a verifier attempts mutation', async () => {
    const verifier = await createSigstoreCapabilitySnapshotAttestationVerifier(
      policy(),
      {},
      async () => ({
        verify: (candidate) => {
          try {
            (
              candidate as { dsseEnvelope?: { payload?: string } }
            ).dsseEnvelope = {
              payload: Buffer.from('{"mutated":true}').toString('base64'),
            };
          } catch {
            // A future/injected verifier may attempt mutation; frozen input
            // must make it ineffective without changing extracted bytes.
          }
          return {} as never;
        },
      }),
    );

    const result = await verifier.verify(bundle());
    expect(new TextDecoder().decode(result.payload)).toBe('{"ok":true}');
  });

  it('rejects an authenticated payload above the statement ceiling', async () => {
    const verify = vi.fn();
    const verifier = await createSigstoreCapabilitySnapshotAttestationVerifier(
      policy(),
      {},
      async () => ({ verify }),
    );

    await expect(
      verifier.verify(
        bundle(Buffer.alloc(MAX_ATTESTATION_STATEMENT_BYTES + 1)),
      ),
    ).rejects.toMatchObject({
      code: 'attestation_payload_too_large',
    });
    expect(verify).not.toHaveBeenCalled();
  });
});
