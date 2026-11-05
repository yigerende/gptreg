"use strict";
// All customer delivery entry points share this database-clock boundary.
// Records remain intact for administrator access and order reconciliation.
const RETENTION_HOURS = 72;
const expiresAt = (alias = "") =>
  `${alias ? `${alias}.` : ""}created_at + interval '${RETENTION_HOURS} hours'`;
const availableAccount = (alias = "") =>
  `${alias ? `${alias}.` : ""}created_at > now() - interval '${RETENTION_HOURS} hours'`;
module.exports = { RETENTION_HOURS, expiresAt, availableAccount };
