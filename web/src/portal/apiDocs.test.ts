import { describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import {
  codeSample,
  pollingExample,
  requestExamples,
  schemaFields,
  type Operation,
} from "./apiDocs";
const require = createRequire(import.meta.url);
const { openapi: spec } = require("../../../src/platform/openapi.js");
const ops: Operation[] = Object.entries(spec.paths).flatMap(
  ([path, methods]: [string, any]) =>
    Object.entries(methods).map(([method, op]: [string, any]) => ({
      path,
      method,
      op,
      id: op.operationId,
    })),
);
describe("API documentation examples", () => {
  it("expands refs, allOf and nested arrays without making optional parents required", () => {
    const fields = schemaFields(spec, spec.components.schemas.OrderDetail);
    expect(fields.find((x) => x.name === "items[].status")?.enum).toContain(
      "oauth_pending",
    );
    expect(fields.find((x) => x.name === "status")?.enum).not.toContain(
      "oauth_pending",
    );
    expect(fields.find((x) => x.name === "quantity")?.required).toBe(true);
    const credentials = schemaFields(spec, spec.components.schemas.Credentials);
    expect(credentials.find((x) => x.name === "oauth")?.required).toBe(false);
    expect(
      credentials.find((x) => x.name === "oauth.refresh_token")?.nested,
    ).toBe(true);
    expect(credentials.find((x) => x.name === "totp_expires_in")?.maximum).toBe(
      30,
    );
  });
  it("generates parseable Python and Node code for every request scenario", () => {
    const python: string[] = [pollingExample("https://example.test")],
      node: string[] = [];
    for (const op of ops)
      for (const scenario of Object.keys(requestExamples(op)).length
        ? Object.keys(requestExamples(op))
        : [""]) {
        python.push(codeSample(op, "https://example.test", "python", scenario));
        node.push(
          `{\n${codeSample(op, "https://example.test", "node", scenario)}\n}`,
        );
        const curl = codeSample(op, "https://example.test", "curl", scenario);
        expect(curl).toContain("$GPTREG_API_KEY");
        expect(curl).not.toMatch(/\{id\}/);
      }
    const py = spawnSync(
      "python",
      [
        "-X",
        "utf8",
        "-c",
        "import ast,json,sys\nfor code in json.load(sys.stdin.buffer): ast.parse(code)",
      ],
      { input: JSON.stringify(python), encoding: "utf8" },
    );
    expect(py.status, py.stderr || String(py.error)).toBe(0);
    const js = spawnSync(process.execPath, ["--input-type=module", "--check"], {
      input: node.join("\n"),
      encoding: "utf8",
    });
    expect(js.status, js.stderr).toBe(0);
  });
  it("keeps scenario parameters, response formats and idempotent headers aligned", () => {
    const create = ops.find((x) => x.id === "create_order")!;
    expect(
      codeSample(create, "https://example.test", "curl", "standard"),
    ).toContain('"need_oauth": false');
    expect(
      codeSample(create, "https://example.test", "node", "oauth"),
    ).toContain('"need_oauth": true');
    expect(
      codeSample(create, "https://example.test", "python", "oauth"),
    ).toContain("YOUR_SAVED_REQUEST_ID");
    for (const status of ["200", "202"])
      for (const scenario of ["standard", "oauth"]) {
        const media = create.op.responses[status].content["application/json"];
        expect(media.example).toBeUndefined();
        expect(media.examples[scenario].value.need_oauth).toBe(
          scenario === "oauth",
        );
      }
    const accounts = ops.find((x) => x.id === "list_accounts")!;
    expect(
      codeSample(accounts, "https://example.test", "curl", "search"),
    ).toContain("demo.account%40gmail.com");
    const exporting = ops.find((x) => x.id === "export_accounts")!;
    for (const format of ["json", "txt", "csv"]) {
      const media = exporting.op.responses["200"].content["application/json"];
      expect(media.examples[format].value.filename).toMatch(
        new RegExp(`\\.${format}$`),
      );
      expect(
        codeSample(exporting, "https://example.test", "python", format),
      ).toContain(`accounts.${format}`);
    }
  });
});
