/** Focus a newly opened date editor and reveal its calendar when no date is set. */
export function focusOpeningDateInput(input: HTMLInputElement): void {
  input.focus();
  if (input.value !== '' || typeof input.showPicker !== 'function') return;
  try {
    input.showPicker();
  } catch (error) {
    console.debug(
      '[abyss-tasks] Native date picker unavailable; date input remains editable.',
      error,
    );
  }
}
