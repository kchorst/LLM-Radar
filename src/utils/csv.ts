export function toCsv(rows: Record<string, unknown>[]): string {
  if (!rows.length) return '';
  const headers = Object.keys(rows[0]);
  const line = (cells: unknown[]) => cells.map(cell => csvCell(cell)).join(',');
  return [line(headers), ...rows.map(row => line(headers.map(h => row[h])) )].join('\n');
}

function csvCell(value: unknown): string {
  if (value == null) return '';
  const raw = typeof value === 'object' ? JSON.stringify(value) : String(value);
  if (/[",\n]/.test(raw)) return `"${raw.replace(/"/g, '""')}"`;
  return raw;
}
