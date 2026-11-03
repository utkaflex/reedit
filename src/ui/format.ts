export function formatCount(
  value: number,
  forms: readonly [string, string, string],
): string {
  const rule = new Intl.PluralRules('ru').select(value);
  return `${String(value)} ${rule === 'one' ? forms[0] : rule === 'few' ? forms[1] : forms[2]}`;
}
