/**
 * Platform-neutral StageFabric contracts and application services.
 *
 * Node-specific configuration, HTTP servers, provider adapters, and demos are
 * deliberately excluded from this entrypoint.
 */
export * from './application/executor.js';
export * from './application/planner.js';
export * from './domain/canonical.js';
export * from './domain/schema.js';
export * from './domain/snapshot.js';
export * from './ports/index.js';
