export const warmReloads = 5, inputRepetitions = 120, editRepetitions = 40;
export const stagesPerFixture = warmReloads + 2;

/** A partial or failed action report must never advance the saved-stage count. */
export function completedStage(report: { scenario: string; failure?: unknown; samples: readonly { name: string; count?: number }[] }) {
  if (report.failure) return undefined;
  const starts = report.samples.filter(sample => sample.name === 'startup-ready');
  if (starts.length === 1 && Number.isInteger(starts[0].count) && starts[0].count! >= 0 && starts[0].count! <= warmReloads) {
    return `${report.scenario}:load-${starts[0].count}`;
  }
  const count = (name: string) => report.samples.filter(sample => sample.name === name).length;
  if (!starts.length && count('input-core') === inputRepetitions && count('input-frame') === inputRepetitions && count('completed-edit') === editRepetitions) {
    return `${report.scenario}:actions`;
  }
  return undefined;
}
