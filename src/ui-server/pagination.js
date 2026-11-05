'use strict';

const { HttpError } = require('./utils');

function pagination(query = {}) {
  const number = (key, fallback, min, max) => {
    if (query[key] === undefined || query[key] === '') return fallback;
    const value = Number(query[key]);
    if (!Number.isSafeInteger(value) || value < min || value > max) throw new HttpError(400, `Invalid ${key}`);
    return value;
  };
  return { offset: number('offset', 0, 0, Number.MAX_SAFE_INTEGER), limit: number('limit', 50, 1, 200) };
}

function pageRows(rows, query = {}) {
  const { offset: requested, limit } = pagination(query);
  const total = rows.length;
  // Deleting the last row of a page returns the preceding valid page.
  const offset = Math.min(requested, Math.max(0, Math.ceil(total / limit) - 1) * limit);
  return { items: rows.slice(offset, offset + limit), total, offset, limit };
}

const deliveryFields = ['cpaExportedAt', 'sub2ApiExportedAt', 'sub2ApiPushedAt', 'nvtokensCardsImportedAt', 'nvtokensMailboxesImportedAt', 'nvtokensCardsPooledAt'];
const unexported = (row) => row.locked !== true && deliveryFields.every(key => !row[key]);
const fresh = (row) => unexported(row) && !['planned', 'self_use', 'sold'].includes(row.lifecycle);

function artifactPage(rows, query) {
  const type = query.type || 'all', lifecycle = query.lifecycle || 'all';
  if (!['all', 'plus', 'oauth'].includes(type) || !['all', 'fresh', 'planned', 'self_use', 'sold'].includes(lifecycle)) throw new HttpError(400, 'Invalid artifact filter');
  const typeCounts = { all: rows.length, plus: rows.filter(row => row.isPlus === true).length };
  typeCounts.oauth = typeCounts.all - typeCounts.plus;
  const typed = rows.filter(row => type === 'all' || (type === 'plus' ? row.isPlus === true : row.isPlus !== true));
  const lifecycleCounts = { all: typed.length, fresh: 0, planned: 0, self_use: 0, sold: 0 };
  for (const row of typed) {
    if (fresh(row)) lifecycleCounts.fresh++;
    if (['planned', 'self_use', 'sold'].includes(row.lifecycle)) lifecycleCounts[row.lifecycle]++;
  }
  const filtered = typed.filter(row => lifecycle === 'all' || (lifecycle === 'fresh' ? fresh(row) : row.lifecycle === lifecycle));
  filtered.sort((a, b) => Number(!unexported(a)) - Number(!unexported(b)) || String(b.modifiedAt).localeCompare(String(a.modifiedAt)) || String(a.key).localeCompare(String(b.key)));
  const { items, ...page } = pageRows(filtered, query);
  return { artifacts: items, ...page, typeCounts, lifecycleCounts };
}

module.exports = { pagination, pageRows, artifactPage };
