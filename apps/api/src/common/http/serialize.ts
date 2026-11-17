export const iso = (d: Date) => d.toISOString();
export const isoOrNull = (d: Date | null | undefined) => (d ? d.toISOString() : null);
