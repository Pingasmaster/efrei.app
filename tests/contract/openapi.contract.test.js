const test = require("node:test");
const assert = require("node:assert/strict");
const SwaggerParser = require("@apidevtools/swagger-parser");
const Ajv = require("ajv");

const API_URL = process.env.API_URL || "http://localhost:4000";

const loadSpec = async () => {
  return SwaggerParser.dereference(`${API_URL}/openapi.json`);
};

const getSchema = (spec, path, method, status, contentType = "application/json") => {
  const pathItem = spec.paths?.[path];
  const operation = pathItem?.[method];
  const response = operation?.responses?.[status];
  const schema = response?.content?.[contentType]?.schema;
  if (!schema) {
    throw new Error(`Missing schema for ${method.toUpperCase()} ${path} ${status}`);
  }
  return schema;
};

const validateResponse = async ({ path, method, status, fetchUrl }) => {
  const spec = await loadSpec();
  const ajv = new Ajv({ strict: false, allErrors: true, validateFormats: false });
  const schema = getSchema(spec, path, method, status);
  const response = await fetch(fetchUrl);
  assert.equal(response.status, Number(status));
  const body = await response.json();
  const validate = ajv.compile(schema);
  const valid = validate(body);
  assert.ok(valid, JSON.stringify(validate.errors, null, 2));
};

test("OpenAPI contract: GET /bets", async () => {
  await validateResponse({
    path: "/bets",
    method: "get",
    status: "200",
    fetchUrl: `${API_URL}/bets`
  });
});

test("OpenAPI contract: GET /offers", async () => {
  await validateResponse({
    path: "/offers",
    method: "get",
    status: "200",
    fetchUrl: `${API_URL}/offers`
  });
});
