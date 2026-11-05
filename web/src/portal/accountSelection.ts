export type AccountChoice = {
  id: string;
  order_id: string;
  download_expires_at: string;
};
export const MAX_ACCOUNT_SELECTION = 1000;
export const isAvailable = (
  row: { download_expires_at: string },
  now: number,
) => Date.parse(row.download_expires_at) > now;
export function mergeSelection(
  current: AccountChoice[],
  added: AccountChoice[],
  now: number,
) {
  const items = new Map(
    current.filter((r) => isAvailable(r, now)).map((r) => [r.id, r]),
  );
  let limited = false;
  for (const row of added) {
    if (!isAvailable(row, now) || items.has(row.id)) continue;
    if (items.size >= MAX_ACCOUNT_SELECTION) {
      limited = true;
      continue;
    }
    items.set(row.id, row);
  }
  return { items: [...items.values()], limited };
}
