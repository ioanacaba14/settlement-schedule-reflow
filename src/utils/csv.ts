export type CsvRow = Record<string, string | number>;

/**
 * Minimal CSV serializer: quotes a field only when it contains a comma,
 * quote, or newline (doubling embedded quotes), per RFC 4180. No external
 * dependency needed for a dataset this small.
 */
export function toCsv(rows: CsvRow[], columns: string[]): string {
  const escape = (value: string | number): string => {
    const str = String(value);
    return /[",\n]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
  };

  const lines = [columns.join(","), ...rows.map((row) => columns.map((col) => escape(row[col] ?? "")).join(","))];
  return lines.join("\n") + "\n";
}
