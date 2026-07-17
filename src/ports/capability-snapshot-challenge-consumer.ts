export interface ConsumeCapabilitySnapshotChallengeRequest {
  readonly challengeDigest: `sha256:${string}`;
  readonly authorizationDigest: `sha256:${string}`;
  readonly consumedAt: string;
}

/** Deployment-owned single-use store. `false` means already consumed. */
export interface CapabilitySnapshotChallengeConsumer {
  consume(request: ConsumeCapabilitySnapshotChallengeRequest): Promise<boolean>;
}
