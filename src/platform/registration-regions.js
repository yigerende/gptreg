"use strict";
const { fail } = require("./security");
const names = new Intl.DisplayNames(["zh-CN"], { type: "region" });

function normalizeRegion(value) {
  if (value === undefined) return "random";
  fail(typeof value === "string" && /^(random|GLOBAL|[A-Z]{2})$/.test(value),
    "registration_region 须为 random 或已配置的国家代码");
  return value;
}

// Public allowlist only. Never return proxy URLs, source APIs, counts or keys.
function registrationRegions(pools = []) {
  return [...new Set(pools.filter(p => p.total > 0 && /^(GLOBAL|[A-Z]{2})$/.test(p.countryCode)).map(p => p.countryCode))]
    .sort()
    .map(code => ({ code, name: code === "GLOBAL" ? "全球（混合地区）" : names.of(code) || code }));
}

function regionTemplate(template, region) {
  const value = { ...template };
  // New customer orders follow the customer's region. Manual engine tasks and
  // orders created before this feature retain their original explicit plan.
  if (region === "random") delete value.proxyAssignments;
  else value.proxyAssignments = [{ workerSlot: 1, kind: "countryPool", countryCode: region }];
  return value;
}
module.exports = { normalizeRegion, registrationRegions, regionTemplate };
