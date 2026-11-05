"use strict";
const { fail } = require("./security");
const { buildSub2ApiDocument } = require("../sub2api");
const { createZipArchive, uniqueEntryName } = require("../zip-archive");

function oauthExport(values, format) {
  fail(
    values.every(
      (value) => value.oauth?.access_token && value.oauth?.refresh_token,
    ),
    "CPA / SUB 仅支持已交付完整 OAuth 的账号，请筛选含 OAuth 账号后导出",
    400,
  );
  const records = values.map((value) => ({
    ...value.oauth,
    type: "codex",
    email: value.oauth.email || value.email,
  }));
  if (format === "sub") {
    let document;
    try {
      document = buildSub2ApiDocument(records);
    } catch {
      fail(
        false,
        "部分账号的 OAuth 数据不完整或格式无效，无法生成 SUB，请联系管理员核实",
        409,
      );
    }
    return {
      filename: `SUB-${records.length}.json`,
      content: JSON.stringify(document, null, 2) + "\n",
    };
  }
  const taken = new Set();
  const entries = records.map((record) => ({
    path: uniqueEntryName(
      `codex-${String(record.email)
        .replace(/[^a-zA-Z0-9@._-]/g, "_")
        .slice(0, 140)}.json`,
      taken,
    ),
    content: JSON.stringify(record, null, 2) + "\n",
  }));
  if (entries.length === 1)
    return { filename: entries[0].path, content: entries[0].content };
  return {
    filename: `CPA-${entries.length}.zip`,
    content: createZipArchive(entries).toString("base64"),
    encoding: "base64",
  };
}
module.exports = { oauthExport };
