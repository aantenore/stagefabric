import {
  createVerifier as createSigstoreVerifier,
  type Bundle,
  type BundleVerifier,
  type VerifyOptions,
} from 'sigstore';
import { z } from 'zod';

import type { CapabilitySnapshotTrustPolicy } from '../domain/capability-snapshot-attestation.js';
import {
  IN_TOTO_STATEMENT_PAYLOAD_TYPE,
  type CapabilitySnapshotAttestationVerifier,
  type VerifiedAttestationEnvelope,
} from '../ports/capability-snapshot-attestation-verifier.js';

export const SIGSTORE_BUNDLE_V03_MEDIA_TYPE =
  'application/vnd.dev.sigstore.bundle.v0.3+json' as const;
export const MAX_ATTESTATION_STATEMENT_BYTES = 256 * 1_024;
export const MAX_SIGSTORE_BUNDLE_BYTES = 4 * 1_024 * 1_024;

const base64Schema = z
  .string()
  .max(2 * 1_024 * 1_024)
  .regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/);

const serializedDsseBundleSchema = z
  .object({
    mediaType: z.literal(SIGSTORE_BUNDLE_V03_MEDIA_TYPE),
    verificationMaterial: z
      .object({
        certificate: z.object({ rawBytes: base64Schema }).strict(),
        tlogEntries: z.array(z.unknown()).min(1).max(16),
        timestampVerificationData: z
          .object({
            rfc3161Timestamps: z.array(z.unknown()).max(16).optional(),
          })
          .strict()
          .optional(),
      })
      // Reject publicKey/x509CertificateChain siblings: protobuf JSON oneof
      // precedence must not authenticate different material than we inspect.
      .strict(),
    dsseEnvelope: z
      .object({
        payloadType: z.literal(IN_TOTO_STATEMENT_PAYLOAD_TYPE),
        payload: base64Schema,
        signatures: z
          .array(
            z
              .object({
                // protobuf JSON omits an empty keyid in real sigstore-js
                // bundles; the signature bytes remain mandatory.
                keyid: z.string().max(512).optional(),
                sig: z
                  .string()
                  .min(1)
                  .max(16 * 1_024),
              })
              .strict(),
          )
          .length(1),
      })
      .strict(),
  })
  // Reject messageSignature beside dsseEnvelope. sigstore's protobuf parser
  // gives the former precedence, which would otherwise authenticate different
  // content than the StageFabric statement extracted below.
  .strict();

export type CapabilityAttestationVerificationErrorCode =
  | 'attestation_bundle_invalid'
  | 'attestation_payload_too_large'
  | 'attestation_signature_invalid'
  | 'sigstore_verifier_unavailable';

/** Content-safe adapter error; upstream errors never cross the boundary. */
export class CapabilityAttestationVerificationError extends Error {
  readonly code: CapabilityAttestationVerificationErrorCode;

  constructor(code: CapabilityAttestationVerificationErrorCode) {
    super(code);
    this.name = 'CapabilityAttestationVerificationError';
    this.code = code;
  }
}

export interface SigstoreCapabilityAttestationVerifierOptions {
  readonly timeoutMs?: number;
  readonly tufMirrorUrl?: string;
  readonly tufRootPath?: string;
  readonly tufCachePath?: string;
  readonly tufForceCache?: boolean;
}

export type SigstoreVerifierFactory = (
  options: VerifyOptions,
) => Promise<BundleVerifier>;

function escapeRegularExpression(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function exactIdentityPattern(value: string): string {
  return `^${escapeRegularExpression(value)}$`;
}

function verificationOptions(
  policy: CapabilitySnapshotTrustPolicy,
  options: SigstoreCapabilityAttestationVerifierOptions,
): VerifyOptions {
  return {
    certificateIssuer: policy.certificateIssuer,
    ...(policy.signerIdentity.type === 'email'
      ? {
          certificateIdentityEmail: exactIdentityPattern(
            policy.signerIdentity.value,
          ),
        }
      : {
          certificateIdentityURI: exactIdentityPattern(
            policy.signerIdentity.value,
          ),
        }),
    ctLogThreshold: policy.certificateThreshold,
    tlogThreshold: policy.transparencyLogThreshold,
    timeout: options.timeoutMs ?? 5_000,
    ...(options.tufMirrorUrl === undefined
      ? {}
      : { tufMirrorURL: options.tufMirrorUrl }),
    ...(options.tufRootPath === undefined
      ? {}
      : { tufRootPath: options.tufRootPath }),
    ...(options.tufCachePath === undefined
      ? {}
      : { tufCachePath: options.tufCachePath }),
    ...(options.tufForceCache === undefined
      ? {}
      : { tufForceCache: options.tufForceCache }),
  };
}

function decodePayload(source: string): Uint8Array {
  const payload = Buffer.from(source, 'base64');
  if (payload.byteLength > MAX_ATTESTATION_STATEMENT_BYTES) {
    throw new CapabilityAttestationVerificationError(
      'attestation_payload_too_large',
    );
  }
  return payload;
}

function parseBundleBytes(source: Uint8Array): unknown {
  if (source.byteLength > MAX_SIGSTORE_BUNDLE_BYTES) {
    throw new CapabilityAttestationVerificationError(
      'attestation_bundle_invalid',
    );
  }
  const copied = Buffer.from(source);
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(copied));
  } catch {
    throw new CapabilityAttestationVerificationError(
      'attestation_bundle_invalid',
    );
  }
}

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (
    typeof value !== 'object' ||
    value === null ||
    seen.has(value) ||
    ArrayBuffer.isView(value)
  ) {
    return value;
  }
  seen.add(value);
  for (const child of Object.values(value)) deepFreeze(child, seen);
  return Object.freeze(value);
}

class SigstoreCapabilitySnapshotAttestationVerifier implements CapabilitySnapshotAttestationVerifier {
  constructor(
    private readonly policy: CapabilitySnapshotTrustPolicy,
    private readonly verifier: BundleVerifier,
  ) {}

  async verify(bundle: Uint8Array): Promise<VerifiedAttestationEnvelope> {
    const parsed = serializedDsseBundleSchema.safeParse(
      parseBundleBytes(bundle),
    );
    if (!parsed.success) {
      throw new CapabilityAttestationVerificationError(
        'attestation_bundle_invalid',
      );
    }

    // Bound and copy the authenticated candidate before the verifier sees the
    // parsed object. A verifier cannot swap the payload across an async fence.
    const payload = decodePayload(parsed.data.dsseEnvelope.payload);
    const frozenBundle = deepFreeze(parsed.data);

    try {
      await this.verifier.verify(frozenBundle as Bundle);
    } catch {
      throw new CapabilityAttestationVerificationError(
        'attestation_signature_invalid',
      );
    }

    return {
      payloadType: IN_TOTO_STATEMENT_PAYLOAD_TYPE,
      payload: new Uint8Array(payload),
      signer: {
        issuer: this.policy.certificateIssuer,
        identityType: this.policy.signerIdentity.type,
        identity: this.policy.signerIdentity.value,
      },
    };
  }
}

export async function createSigstoreCapabilitySnapshotAttestationVerifier(
  policy: CapabilitySnapshotTrustPolicy,
  options: SigstoreCapabilityAttestationVerifierOptions = {},
  createVerifier: SigstoreVerifierFactory = createSigstoreVerifier,
): Promise<CapabilitySnapshotAttestationVerifier> {
  try {
    const verifier = await createVerifier(verificationOptions(policy, options));
    return new SigstoreCapabilitySnapshotAttestationVerifier(policy, verifier);
  } catch {
    throw new CapabilityAttestationVerificationError(
      'sigstore_verifier_unavailable',
    );
  }
}
