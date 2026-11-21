/** Compare coordinates at the precision the DOM can represent in CSSOM. */
export function serializedPercent(value: number): string {
  const style = createDiv().style;
  style.left = `${value}%`;
  return style.left;
}
