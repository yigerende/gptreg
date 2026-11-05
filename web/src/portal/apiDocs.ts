import type { Row } from "./client";
export type Operation = { path: string; method: string; id: string; op: Row };
export type Language = "curl" | "python" | "node";
export const languages = { curl: "cURL", python: "Python", node: "Node.js" };
export function resolve(spec: Row, value: Row = {}, depth = 0): Row {
  if (depth > 10) return {};
  if (value.$ref) {
    const target = value.$ref
      .slice(2)
      .split("/")
      .reduce(
        (v: Row | undefined, k: string) =>
          v?.[k.replace(/~1/g, "/").replace(/~0/g, "~")],
        spec,
      );
    const { $ref: _, ...rest } = value;
    return { ...resolve(spec, target || {}, depth + 1), ...rest };
  }
  if (value.allOf) {
    const parts = value.allOf.map((p: Row) => resolve(spec, p, depth + 1));
    const { allOf: _, ...rest } = value;
    return {
      ...rest,
      type: "object",
      properties: Object.assign({}, ...parts.map((p: Row) => p.properties)),
      required: [...new Set(parts.flatMap((p: Row) => p.required || []))],
    };
  }
  return value;
}
export function schemaFields(
  spec: Row,
  value: Row = {},
  prefix = "",
  depth = 0,
): Row[] {
  if (depth > 5) return [];
  const s = resolve(spec, value);
  return Object.entries(s.properties || {}).flatMap(([name, raw]) => {
    const field = resolve(spec, raw as Row),
      full = prefix + name;
    return [
      {
        ...field,
        name: full,
        required: s.required?.includes(name),
        nested: Boolean(prefix),
      },
      ...schemaFields(
        spec,
        field.items || field,
        full + (field.items ? "[]." : "."),
        depth + 1,
      ),
    ];
  });
}
export function fieldType(field: Row): string {
  if (field.type === "array") return `${fieldType(field.items || {})}[]`;
  if (field.$ref) return field.$ref.split("/").at(-1);
  return Array.isArray(field.type)
    ? field.type.join(" / ")
    : field.type || "object";
}
export function fieldRules(field: Row): string {
  const rules: string[] = [];
  if (field.const !== undefined)
    rules.push(`固定 ${JSON.stringify(field.const)}`);
  if (field.default !== undefined)
    rules.push(`默认 ${JSON.stringify(field.default)}`);
  if (field.enum)
    rules.push(
      `可选 ${field.enum.map((v: unknown) => (v === "" ? "空字符串" : String(v))).join(" / ")}`,
    );
  if (field.minimum !== undefined) rules.push(`最小 ${field.minimum}`);
  if (field.maximum !== undefined) rules.push(`最大 ${field.maximum}`);
  if (field.minLength !== undefined || field.maxLength !== undefined)
    rules.push(`长度 ${field.minLength || 0}～${field.maxLength ?? "不限"}`);
  if (field.minItems !== undefined || field.maxItems !== undefined)
    rules.push(`数量 ${field.minItems || 0}～${field.maxItems ?? "不限"}`);
  if (field.format) rules.push(`格式 ${field.format}`);
  return rules.join("；");
}
export function requestExamples(x: Operation): Row {
  return (
    x.op.requestBody?.content?.["application/json"]?.examples ||
    x.op["x-query-examples"] ||
    {}
  );
}
export function codeSample(
  x: Operation,
  origin: string,
  lang: Language,
  exampleKey?: string,
): string {
  const examples = requestExamples(x),
    choice = examples[exampleKey || Object.keys(examples)[0]]?.value;
  const body = x.op.requestBody ? choice : undefined;
  let url = origin + x.path;
  for (const p of x.op.parameters || [])
    if (p.in === "path")
      url = url.replace(
        `{${p.name}}`,
        encodeURIComponent(p.example || "RECORD_ID"),
      );
  if (!x.op.requestBody && choice)
    url += `?${new URLSearchParams(Object.entries(choice).map(([k, v]) => [k, String(v)]))}`;
  const headers: Row = { Authorization: "Bearer YOUR_API_KEY" };
  for (const p of x.op.parameters || [])
    if (p.in === "header" && p.required) headers[p.name] = p.example || "VALUE";
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (lang === "python")
    return `import json\nimport os\nimport requests\n\nheaders = ${JSON.stringify(headers, null, 2).replace('"Bearer YOUR_API_KEY"', '"Bearer " + os.environ["GPTREG_API_KEY"]')}\n${body === undefined ? "" : `payload = json.loads(${JSON.stringify(JSON.stringify(body))})\n`}response = requests.${x.method}(\n    ${JSON.stringify(url)},\n    headers=headers,${body === undefined ? "" : " json=payload,"}\n    timeout=30,\n)\nresponse.raise_for_status()\nresult = response.json()\nprint(result)${x.id === "export_accounts" ? '\n# 保存正文时使用你指定的本地路径，不要将 JSON 封装直接当作文件正文。\n# from pathlib import Path\n# Path("accounts.' + (body?.format || "txt") + '").write_text(result["content"], encoding="utf-8")' : ""}`;
  if (lang === "node")
    return `const apiKey = process.env.GPTREG_API_KEY;\nif (!apiKey) throw new Error("请先设置 GPTREG_API_KEY");\nconst response = await fetch(${JSON.stringify(url)}, {\n  method: ${JSON.stringify(x.method.toUpperCase())},\n  signal: AbortSignal.timeout(30000),\n  headers: ${JSON.stringify(headers, null, 2).replace('"Bearer YOUR_API_KEY"', '"Bearer " + apiKey')}${body === undefined ? "" : `,\n  body: JSON.stringify(${JSON.stringify(body, null, 2)})`}\n});\nconst result = await response.json();\nif (!response.ok) throw new Error(result.error || response.statusText);\nconsole.log(result);${x.id === "export_accounts" ? '\n// 用指定的本地路径保存 result.content。\n// const { writeFile } = await import("node:fs/promises");\n// await writeFile("accounts.' + (body?.format || "txt") + '", result.content, "utf8");' : ""}`;
  const quote = (v: string) => "'" + v.replaceAll("'", "'\\''") + "'";
  return (
    `curl --fail-with-body --connect-timeout 10 --max-time 30 ${quote(url)} \\\n  -X ${x.method.toUpperCase()} \\\n  ` +
    Object.entries(headers)
      .map(([k, v]) =>
        k === "Authorization"
          ? '-H "Authorization: Bearer $GPTREG_API_KEY"'
          : `-H ${quote(k + ": " + v)}`,
      )
      .join(" \\\n  ") +
    (body === undefined
      ? ""
      : ` \\\n  --data-raw ${quote(JSON.stringify(body, null, 2))}`)
  );
}
export function pollingExample(origin: string): string {
  return `import os\nimport time\nimport requests\n\nbase = ${JSON.stringify(origin)}\nheaders = {"Authorization": "Bearer " + os.environ["GPTREG_API_KEY"]}\n# 替换为你已经保存的订单 ID；这一段只查询，不会重复下单。\norder_id = "ORDER_ID"\ndeadline = time.monotonic() + 20 * 60\nterminal = {"completed", "partial", "failed", "cancelled"}\n\nwhile time.monotonic() < deadline:\n    response = requests.get(\n        f"{base}/open/v1/registration-orders/{order_id}",\n        headers=headers, timeout=30,\n    )\n    if response.status_code == 429:\n        time.sleep(max(5, int(response.headers.get("Retry-After", "60"))))\n        continue\n    response.raise_for_status()\n    order = response.json()\n    print(order["status"], order["delivered"], order["quantity"])\n    if order["status"] == "review":\n        raise RuntimeError("订单待核实，请保留订单 ID 并联系支持；不要重新下单")\n    if order["status"] in terminal:\n        break\n    time.sleep(5)\nelse:\n    raise TimeoutError("达到本次查询时限；保存原订单 ID，稍后继续查询")\n\n# completed/partial 时领取已交付部分，按实际总量分页。\naccount_ids = []\noffset = 0\nwhile True:\n    response = requests.get(\n        base + "/open/v1/accounts", headers=headers,\n        params={"order_id": order_id, "limit": 100, "offset": offset},\n        timeout=30,\n    )\n    response.raise_for_status()\n    page = response.json()\n    account_ids.extend(item["id"] for item in page["items"])\n    offset += page["limit"]\n    if offset >= page["total"] or not page["items"]:\n        break\nprint("已交付账号 ID:", list(dict.fromkeys(account_ids)))\n# 需要凭据时分批调用 accounts/export，每批最多 100 个 ID。`;
}
