import { z } from 'zod';

export const STAGEFABRIC_API_VERSION = 'stagefabric.dev/v1alpha1' as const;
export const INTERNAL_OPERATION_CAPABILITY_PREFIX =
  'stagefabric.operation/' as const;
export const sha256DigestSchema = z.string().regex(/^sha256:[0-9a-f]{64}$/);

export function internalOperationCapability(operation: string): string {
  return `${INTERNAL_OPERATION_CAPABILITY_PREFIX}${operation}`;
}

const nameSchema = z.string().trim().min(1).max(128);
const graphIdentifierSchema = z
  .string()
  .regex(
    /^[a-z][a-z0-9_-]*$/,
    "must start with a lowercase letter and contain only lowercase letters, digits, '_' or '-'",
  )
  .max(64);
const observedCapabilitySchema = z.string().trim().min(1).max(256);
const capabilitySchema = observedCapabilitySchema.refine(
  (capability) => !capability.startsWith(INTERNAL_OPERATION_CAPABILITY_PREFIX),
  'reserved for StageFabric operation availability evidence',
);
const dataTypeSchema = z.string().trim().min(1).max(256);
export const timestampSchema = z.string().datetime({ offset: true });

function uniqueStrings(schema: z.ZodType<string>) {
  return z.array(schema).superRefine((values, context) => {
    const seen = new Set<string>();
    for (const [index, value] of values.entries()) {
      if (seen.has(value)) {
        context.addIssue({
          code: 'custom',
          message: `duplicate value '${value}'`,
          path: [index],
        });
      }
      seen.add(value);
    }
  });
}

function requireUniqueBy<T>(
  values: readonly T[],
  key: (value: T) => string | number,
  path: string,
  context: z.RefinementCtx,
) {
  const seen = new Set<string | number>();
  for (const [index, value] of values.entries()) {
    const itemKey = key(value);
    if (seen.has(itemKey)) {
      context.addIssue({
        code: 'custom',
        message: `duplicate value '${String(itemKey)}'`,
        path: [path, index],
      });
    }
    seen.add(itemKey);
  }
}

const labelsSchema = z.record(
  z.string().trim().min(1).max(128),
  z.string().max(512),
);

export const fabricZoneSchema = z
  .object({
    id: nameSchema,
    trustLevel: z.number().int().min(0),
    residencies: uniqueStrings(nameSchema).default([]),
    labels: labelsSchema.default({}),
  })
  .strict();

export const classificationSchema = z
  .object({
    id: nameSchema,
    rank: z.number().int().min(0),
    minTrustLevel: z.number().int().min(0).default(0),
    allowedZones: uniqueStrings(nameSchema).default([]),
    allowedResidencies: uniqueStrings(nameSchema).default([]),
  })
  .strict();

export const fabricTargetSchema = z
  .object({
    id: nameSchema,
    zone: nameSchema,
    adapter: z
      .object({
        kind: nameSchema,
      })
      .strict(),
    capabilities: uniqueStrings(capabilitySchema).min(1),
    expectedP95Ms: z.number().int().min(0),
    costMicros: z.number().int().min(0),
    labels: labelsSchema.default({}),
  })
  .strict();

export const fabricSchema = z
  .object({
    apiVersion: z.literal(STAGEFABRIC_API_VERSION),
    kind: z.literal('Fabric'),
    zones: z.array(fabricZoneSchema).min(1),
    classifications: z.array(classificationSchema).min(1),
    targets: z.array(fabricTargetSchema).min(1),
    policy: z
      .object({
        zonePreference: uniqueStrings(nameSchema).default([]),
        maxFallbacks: z.number().int().min(0).max(32).default(2),
      })
      .strict()
      .default({ zonePreference: [], maxFallbacks: 2 }),
  })
  .strict()
  .superRefine((fabric, context) => {
    requireUniqueBy(fabric.zones, (zone) => zone.id, 'zones', context);
    requireUniqueBy(
      fabric.classifications,
      (classification) => classification.id,
      'classifications',
      context,
    );
    requireUniqueBy(
      fabric.classifications,
      (classification) => classification.rank,
      'classifications',
      context,
    );
    requireUniqueBy(fabric.targets, (target) => target.id, 'targets', context);

    const zoneIds = new Set(fabric.zones.map((zone) => zone.id));
    for (const [index, target] of fabric.targets.entries()) {
      if (!zoneIds.has(target.zone)) {
        context.addIssue({
          code: 'custom',
          message: `target references unknown zone '${target.zone}'`,
          path: ['targets', index, 'zone'],
        });
      }
    }

    for (const [index, classification] of fabric.classifications.entries()) {
      for (const zone of classification.allowedZones) {
        if (!zoneIds.has(zone)) {
          context.addIssue({
            code: 'custom',
            message: `classification references unknown zone '${zone}'`,
            path: ['classifications', index, 'allowedZones'],
          });
        }
      }
    }

    for (const [index, zone] of fabric.policy.zonePreference.entries()) {
      if (!zoneIds.has(zone)) {
        context.addIssue({
          code: 'custom',
          message: `policy references unknown zone '${zone}'`,
          path: ['policy', 'zonePreference', index],
        });
      }
    }
  });

export const capabilityTargetStateSchema = z
  .object({
    targetId: nameSchema,
    healthy: z.boolean(),
    // Snapshots may contain trusted, internally derived operation evidence.
    capabilities: uniqueStrings(observedCapabilitySchema),
    observedAt: timestampSchema.optional(),
    expiresAt: timestampSchema.optional(),
    expectedP95Ms: z.number().int().min(0).optional(),
    costMicros: z.number().int().min(0).optional(),
  })
  .strict()
  .superRefine((state, context) => {
    if (state.observedAt !== undefined && state.expiresAt !== undefined) {
      if (Date.parse(state.observedAt) >= Date.parse(state.expiresAt)) {
        context.addIssue({
          code: 'custom',
          message: 'observedAt must be earlier than expiresAt',
          path: ['expiresAt'],
        });
      }
    }
  });

const capabilitySnapshotShape = {
  apiVersion: z.literal(STAGEFABRIC_API_VERSION),
  kind: z.literal('CapabilitySnapshot'),
  bindingDigest: sha256DigestSchema.optional(),
  observedAt: timestampSchema,
  expiresAt: timestampSchema,
  targets: z.array(capabilityTargetStateSchema),
} as const;

function validateSnapshotTimeline(
  snapshot: {
    observedAt: string;
    expiresAt: string;
    targets: readonly { targetId: string }[];
  },
  context: z.RefinementCtx,
) {
  if (Date.parse(snapshot.observedAt) >= Date.parse(snapshot.expiresAt)) {
    context.addIssue({
      code: 'custom',
      message: 'observedAt must be earlier than expiresAt',
      path: ['expiresAt'],
    });
  }
  requireUniqueBy(
    snapshot.targets,
    (target) => target.targetId,
    'targets',
    context,
  );
}

export const capabilitySnapshotContentSchema = z
  .object(capabilitySnapshotShape)
  .strict()
  .superRefine(validateSnapshotTimeline);

export const capabilitySnapshotSchema = z
  .object({
    ...capabilitySnapshotShape,
    digest: sha256DigestSchema,
  })
  .strict()
  .superRefine(validateSnapshotTimeline);

export const graphInputSchema = z
  .object({
    name: graphIdentifierSchema,
    type: dataTypeSchema,
    classification: nameSchema,
    residencies: uniqueStrings(nameSchema).default([]),
    origin: z
      .object({
        zone: nameSchema,
        targetId: nameSchema.optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

export const stageInputBindingSchema = z
  .object({
    ref: z
      .string()
      .regex(
        /^(?:input|[a-z][a-z0-9_-]*)\.[a-z][a-z0-9_-]*$/,
        'must be input.X or stage.output',
      ),
    type: dataTypeSchema,
  })
  .strict();

export const stageOutputSchema = z
  .object({
    name: graphIdentifierSchema,
    type: dataTypeSchema,
    classification: nameSchema.optional(),
  })
  .strict();

export const declassificationSchema = z
  .object({
    output: graphIdentifierSchema,
    toClassification: nameSchema,
    authorityCapability: capabilitySchema,
    justification: z.string().trim().min(8).max(512),
  })
  .strict();

export const stageSchema = z
  .object({
    id: graphIdentifierSchema.refine(
      (id) => id !== 'input',
      "'input' is reserved",
    ),
    operation: nameSchema,
    inputs: z.record(graphIdentifierSchema, stageInputBindingSchema),
    outputs: z.array(stageOutputSchema).min(1),
    requirements: z
      .object({
        capabilities: uniqueStrings(capabilitySchema).default([]),
        allowedZones: uniqueStrings(nameSchema).default([]),
        residencies: uniqueStrings(nameSchema).default([]),
      })
      .strict()
      .default({ capabilities: [], allowedZones: [], residencies: [] }),
    declassifications: z.array(declassificationSchema).default([]),
  })
  .strict()
  .superRefine((stage, context) => {
    requireUniqueBy(stage.outputs, (output) => output.name, 'outputs', context);
    requireUniqueBy(
      stage.declassifications,
      (rule) => rule.output,
      'declassifications',
      context,
    );
  });

export const stageGraphSchema = z
  .object({
    apiVersion: z.literal(STAGEFABRIC_API_VERSION),
    kind: z.literal('StageGraph'),
    metadata: z
      .object({
        name: nameSchema,
        labels: labelsSchema.default({}),
      })
      .strict(),
    inputs: z.array(graphInputSchema).default([]),
    stages: z.array(stageSchema).min(1),
  })
  .strict()
  .superRefine((graph, context) => {
    requireUniqueBy(graph.inputs, (input) => input.name, 'inputs', context);
    requireUniqueBy(graph.stages, (stage) => stage.id, 'stages', context);
  });

export type Fabric = z.infer<typeof fabricSchema>;
export type FabricZone = z.infer<typeof fabricZoneSchema>;
export type Classification = z.infer<typeof classificationSchema>;
export type FabricTarget = z.infer<typeof fabricTargetSchema>;
export type CapabilityTargetState = z.infer<typeof capabilityTargetStateSchema>;
export type CapabilitySnapshotContent = z.infer<
  typeof capabilitySnapshotContentSchema
>;
export type CapabilitySnapshot = z.infer<typeof capabilitySnapshotSchema>;
export type StageGraph = z.infer<typeof stageGraphSchema>;
export type GraphInput = z.infer<typeof graphInputSchema>;
export type Stage = z.infer<typeof stageSchema>;
export type StageOutput = z.infer<typeof stageOutputSchema>;
export type Declassification = z.infer<typeof declassificationSchema>;
