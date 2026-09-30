/**
 * Runtime-switchable demo scenario: fake/live data mode plus failure injection.
 * Initial state is read from the real environment (SCENARIO_* — set by shell or
 * Docker env_file) and validated exactly like app_config validates PORT/LOG_LEVEL.
 * The store itself is mutable so later demo endpoints can flip it at runtime.
 */

const VALID_DATA_MODES = ['fake', 'live'] as const;
export type ScenarioDataMode = (typeof VALID_DATA_MODES)[number];

export interface ScenarioState {
  readonly dataMode: ScenarioDataMode;
  readonly injectFailure: boolean;
}

function parseDataMode(raw: string | undefined): ScenarioDataMode {
  const value = raw === undefined || raw === '' ? 'fake' : raw;
  if (!(VALID_DATA_MODES as readonly string[]).includes(value)) {
    throw new Error(
      `Invalid SCENARIO_DATA_MODE "${value}". Expected one of: ${VALID_DATA_MODES.join(', ')}.`,
    );
  }
  return value as ScenarioDataMode;
}

function parseInjectFailure(raw: string | undefined): boolean {
  const value = raw === undefined || raw === '' ? 'false' : raw;
  if (value !== 'true' && value !== 'false') {
    throw new Error(`Invalid SCENARIO_INJECT_FAILURE "${value}". Expected "true" or "false".`);
  }
  return value === 'true';
}

export function createScenarioState(env: NodeJS.ProcessEnv = process.env): ScenarioState {
  return Object.freeze({
    dataMode: parseDataMode(env.SCENARIO_DATA_MODE),
    injectFailure: parseInjectFailure(env.SCENARIO_INJECT_FAILURE),
  });
}

export interface ScenarioStore {
  get(): ScenarioState;
  set(patch: Partial<ScenarioState>): ScenarioState;
  reset(): void;
}

export function createScenarioStore(initial: ScenarioState = createScenarioState()): ScenarioStore {
  let state = initial;

  return {
    get: () => state,
    set(patch) {
      // Runtime validation: patches will later arrive from HTTP bodies as
      // untyped JSON, so the store defends its own invariant.
      if (
        patch.dataMode !== undefined &&
        !(VALID_DATA_MODES as readonly string[]).includes(patch.dataMode)
      ) {
        throw new Error(
          `Invalid dataMode "${String(patch.dataMode)}". Expected one of: ${VALID_DATA_MODES.join(', ')}.`,
        );
      }
      if (patch.injectFailure !== undefined && typeof patch.injectFailure !== 'boolean') {
        throw new Error(`Invalid injectFailure "${String(patch.injectFailure)}". Expected a boolean.`);
      }
      state = Object.freeze({ ...state, ...patch });
      return state;
    },
    reset() {
      state = initial;
    },
  };
}

export const scenarioStore: ScenarioStore = createScenarioStore();
