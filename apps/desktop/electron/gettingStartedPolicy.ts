export const GETTING_STARTED_STEPS = ['import', 'layout', 'default-browser'] as const;
export type GettingStartedStep = typeof GETTING_STARTED_STEPS[number];
export type GettingStartedState = { version: 1; completed: GettingStartedStep[]; dismissed: boolean };
export const initialGettingStarted = (): GettingStartedState => ({ version: 1, completed: [], dismissed: false });
export function guideFinished(state: GettingStartedState) {
  return state.dismissed || GETTING_STARTED_STEPS.every(step => state.completed.includes(step));
}
