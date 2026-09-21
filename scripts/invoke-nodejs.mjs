#!/usr/bin/env node
// 使用 Node.js AWS SDK 签名 Function URL 请求，或生成预签名 URL。
//
// 依赖：
//   npm i @smithy/signature-v4 @smithy/protocol-http \
//         @aws-sdk/credential-provider-node @aws-crypto/sha256-js \
//         @aws-sdk/util-format-url
//
// 用法：
//   export FUNCTION_URL="https://<id>.lambda-url.<region>.on.aws/"
//   node invoke-nodejs.mjs signed  photos/cat.jpg 400 300
//   node invoke-nodejs.mjs presign photos/cat.jpg 400 300 3600

import { writeFile } from "node:fs/promises";
import { HttpRequest } from "@smithy/protocol-http";
import { SignatureV4 } from "@smithy/signature-v4";
import { defaultProvider } from "@aws-sdk/credential-provider-node";
import { Sha256 } from "@aws-crypto/sha256-js";
import { formatUrl } from "@aws-sdk/util-format-url";

const FUNCTION_URL = process.env.FUNCTION_URL?.replace(/\/$/, "");
const REGION = process.env.AWS_REGION ?? "ap-northeast-1";

if (!FUNCTION_URL) {
  console.error("FUNCTION_URL is required");
  process.exit(1);
}

const signer = new SignatureV4({
  credentials: defaultProvider(),
  region: REGION,
  service: "lambda",
  sha256: Sha256,
});

function buildRequest(key, width, height, fmt = "webp") {
  const u = new URL(FUNCTION_URL + "/");
  u.searchParams.set("key", key);
  u.searchParams.set("width", width);
  u.searchParams.set("height", height);
  u.searchParams.set("format", fmt);
  return new HttpRequest({
    protocol: u.protocol,
    hostname: u.hostname,
    method: "GET",
    path: u.pathname,
    query: Object.fromEntries(u.searchParams.entries()),
    headers: { host: u.host },
  });
}

async function signedGet(key, width, height) {
  const req = buildRequest(key, width, height);
  const signed = await signer.sign(req);

  const url = `${signed.protocol}//${signed.hostname}${signed.path}?` +
    new URLSearchParams(signed.query).toString();

  const response = await fetch(url, {
    method: signed.method,
    headers: signed.headers,
    signal: AbortSignal.timeout(30000),
  });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${await response.text()}`);
  }
  const buf = Buffer.from(await response.arrayBuffer());
  await writeFile("out.webp", buf);
  console.log(`HTTP ${response.status}  Content-Type: ${response.headers.get("content-type")}`);
  console.log(`X-Cache: ${response.headers.get("x-cache")}`);
  console.log(`saved: out.webp (${buf.length} bytes)`);
}

async function presign(key, width, height, expires = 3600) {
  const req = buildRequest(key, width, height);
  const signed = await signer.presign(req, { expiresIn: expires });
  return formatUrl(signed);
}

const [mode, key, w, h, exp] = process.argv.slice(2);
if (!mode || !key || !w || !h) {
  console.error("usage: invoke-nodejs.mjs {signed|presign} <key> <width> <height> [expires]");
  process.exit(1);
}

if (mode === "signed") {
  await signedGet(key, +w, +h);
} else if (mode === "presign") {
  console.log(await presign(key, +w, +h, exp ? +exp : 3600));
} else {
  console.error(`unknown mode: ${mode}`);
  process.exit(2);
}
