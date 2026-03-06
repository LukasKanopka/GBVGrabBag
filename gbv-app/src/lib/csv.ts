export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];

    if (inQuotes) {
      if (ch === '"') {
        const next = text[i + 1];
        if (next === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
      continue;
    }

    if (ch === '"') {
      inQuotes = true;
      continue;
    }

    if (ch === ',') {
      row.push(field);
      field = '';
      continue;
    }

    if (ch === '\n') {
      row.push(field);
      field = '';
      rows.push(row);
      row = [];
      continue;
    }

    if (ch === '\r') {
      continue;
    }

    field += ch;
  }

  row.push(field);
  if (row.some((c) => c.trim().length > 0)) rows.push(row);

  // Remove trailing empty rows (common from editors / Sheets exports)
  while (rows.length > 0 && rows[rows.length - 1].every((c) => (c ?? '').trim() === '')) {
    rows.pop();
  }

  return rows;
}

export function normalizeHeader(h: string): string {
  // Trim BOM + normalize to snake-ish identifiers
  return (h || '')
    .replace(/^\uFEFF/, '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '_');
}

export function normalizeCell(value: unknown): string {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

export function csvToObjects(text: string): Array<Record<string, string>> {
  const rows = parseCsv(text);
  if (rows.length === 0) return [];
  const headers = (rows[0] || []).map(normalizeHeader);

  const out: Array<Record<string, string>> = [];
  for (const raw of rows.slice(1)) {
    const rec: Record<string, string> = {};
    for (let i = 0; i < headers.length; i++) {
      const key = headers[i] || `col_${i + 1}`;
      rec[key] = normalizeCell(raw[i] ?? '');
    }
    out.push(rec);
  }
  return out;
}

function escapeCsvField(v: string): string {
  const needsQuotes = /[",\n\r]/.test(v);
  const escaped = v.replace(/"/g, '""');
  return needsQuotes ? `"${escaped}"` : escaped;
}

export function objectsToCsv(rows: Array<Record<string, unknown>>, columns: string[]): string {
  const header = columns.join(',');
  const lines = rows.map((r) => {
    const vals = columns.map((c) => escapeCsvField(normalizeCell((r as any)[c])));
    return vals.join(',');
  });
  return [header, ...lines].join('\n');
}

