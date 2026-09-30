import { afterEach, describe, expect, it } from 'vitest';
import { createScenarioState, createScenarioStore, scenarioStore } from './scenario.js';

describe('createScenarioState', () => {
  it('defaults to fake mode without failure injection', () => {
    expect(createScenarioState({})).toEqual({ dataMode: 'fake', injectFailure: false });
  });

  it('reads SCENARIO_DATA_MODE and SCENARIO_INJECT_FAILURE from the environment', () => {
    expect(
      createScenarioState({ SCENARIO_DATA_MODE: 'live', SCENARIO_INJECT_FAILURE: 'true' }),
    ).toEqual({ dataMode: 'live', injectFailure: true });
  });

  it('treats empty strings as unset, like app_config does', () => {
    expect(createScenarioState({ SCENARIO_DATA_MODE: '', SCENARIO_INJECT_FAILURE: '' })).toEqual({
      dataMode: 'fake',
      injectFailure: false,
    });
  });

  it('throws on a malformed SCENARIO_DATA_MODE', () => {
    expect(() => createScenarioState({ SCENARIO_DATA_MODE: 'prod-ish' })).toThrow(
      /Invalid SCENARIO_DATA_MODE "prod-ish"/,
    );
  });

  it('throws on a malformed SCENARIO_INJECT_FAILURE', () => {
    expect(() => createScenarioState({ SCENARIO_INJECT_FAILURE: 'yes' })).toThrow(
      /Invalid SCENARIO_INJECT_FAILURE "yes"/,
    );
  });
});

describe('scenarioStore', () => {
  afterEach(() => {
    scenarioStore.reset();
  });

  it('set patches only the provided fields and get returns current state', () => {
    scenarioStore.set({ injectFailure: true });
    expect(scenarioStore.get().injectFailure).toBe(true);

    scenarioStore.set({ dataMode: 'live' });
    expect(scenarioStore.get()).toEqual({ dataMode: 'live', injectFailure: true });
  });

  it('reset returns to the initial state the store was created with', () => {
    const store = createScenarioStore({ dataMode: 'live', injectFailure: false });
    store.set({ injectFailure: true });

    store.reset();
    expect(store.get()).toEqual({ dataMode: 'live', injectFailure: false });
  });

  it('set rejects invalid runtime patches (future HTTP bodies arrive untyped)', () => {
    expect(() =>
      scenarioStore.set({ dataMode: 'staging' as unknown as 'live' }),
    ).toThrow(/Invalid dataMode "staging"/);
    expect(() =>
      scenarioStore.set({ injectFailure: 'yes' as unknown as boolean }),
    ).toThrow(/Invalid injectFailure/);
  });
});
