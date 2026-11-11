import { SecretComponent, type App, type Setting } from 'obsidian';
import { providerFailure } from '../../ai/providers/providerFailure';

/** Only the native chooser handles credential entry. Its callback supplies a secret ID. */
export function renderProviderSecret(
  row: Setting,
  app: App,
  getId: () => string | null,
  changed: (id: string | null) => void,
): void {
  try {
    const id = selectedId(row, getId);
    new SecretComponent(app, row.controlEl).setValue(id).onChange(changed);
  } catch (error) {
    showFailure(row, error);
  }
}
function selectedId(row: Setting, getId: () => string | null): string {
  try {
    return getId() ?? '';
  } catch (error) {
    showFailure(row, error);
    return '';
  }
}
function showFailure(row: Setting, error: unknown): void {
  const failure = providerFailure(error);
  row.setDesc(failure.message);
  console.error('[abyss-tasks] Provider secret selection failed', { code: failure.code });
}
