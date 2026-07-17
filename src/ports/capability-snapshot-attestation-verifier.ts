export const IN_TOTO_STATEMENT_PAYLOAD_TYPE =
  'application/vnd.in-toto+json' as const;

/** Content-safe identity returned only after the envelope verifies. */
export interface VerifiedAttestationSigner {
  readonly issuer: string;
  readonly identityType: 'uri' | 'email';
  readonly identity: string;
}

/**
 * Authenticated DSSE payload. Envelope parsing and cryptographic verification
 * stay behind this port; statement semantics remain in the application core.
 */
export interface VerifiedAttestationEnvelope {
  readonly payloadType: typeof IN_TOTO_STATEMENT_PAYLOAD_TYPE;
  readonly payload: Uint8Array;
  readonly signer: VerifiedAttestationSigner;
}

export interface CapabilitySnapshotAttestationVerifier {
  /** The implementation copies bounded bytes before its first async boundary. */
  verify(bundle: Uint8Array): Promise<VerifiedAttestationEnvelope>;
}
