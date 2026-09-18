export function toJsonDocument(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}
