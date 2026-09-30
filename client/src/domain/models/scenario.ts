/**
 * ScenarioReport — the pure domain model of GET /api/demo/scenario: the
 * server's runtime fake/live data mode and failure-injection state, shown in
 * the home screen's status chips.
 *
 * `DataMode` is a const object + literal union (not an `enum`) to stay
 * compatible with `erasableSyntaxOnly`.
 */
export const DataMode = {
  Fake: 'fake',
  Live: 'live',
} as const;

export type DataMode = (typeof DataMode)[keyof typeof DataMode];

export interface ScenarioReport {
  dataMode: DataMode;
  injectFailure: boolean;
}
