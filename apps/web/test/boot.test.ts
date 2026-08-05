import { beforeEach, describe, expect, it, vi } from 'vitest';

const gates = vi.hoisted(() => ({
  appUrl: vi.fn(),
  auth: vi.fn(),
  databaseUrl: vi.fn(),
  isBuildPhase: vi.fn(() => false),
  proxyStrategy: vi.fn(),
  realtimeOrigin: vi.fn(),
}));

vi.mock('../lib/auth', () => ({ auth: gates.auth }));
vi.mock('../lib/env', () => ({
  appUrl: gates.appUrl,
  databaseUrl: gates.databaseUrl,
  isBuildPhase: gates.isBuildPhase,
  proxyStrategy: gates.proxyStrategy,
  realtimeOrigin: gates.realtimeOrigin,
}));

import { assertServingConfig } from '../lib/boot';

beforeEach(() => {
  vi.clearAllMocks();
  gates.isBuildPhase.mockReturnValue(false);
});

describe('web process boot condition', () => {
  it('constructs auth after exercising every lazy runtime gate', () => {
    /**
     * Mutation: delete any accessor or the auth construction. The container
     * could then report running while every real page fails on its first use.
     */
    assertServingConfig();
    expect(gates.appUrl).toHaveBeenCalledOnce();
    expect(gates.databaseUrl).toHaveBeenCalledOnce();
    expect(gates.proxyStrategy).toHaveBeenCalledOnce();
    expect(gates.realtimeOrigin).toHaveBeenCalledOnce();
    expect(gates.auth).toHaveBeenCalledOnce();
  });

  it('does not require serving credentials during next build', () => {
    /** Mutation: remove the build-phase return, making image compilation need runtime secrets. */
    gates.isBuildPhase.mockReturnValue(true);
    assertServingConfig();
    expect(gates.appUrl).not.toHaveBeenCalled();
    expect(gates.auth).not.toHaveBeenCalled();
  });
});
