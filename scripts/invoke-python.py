#!/usr/bin/env python3
"""调用 Function URL 的两种方式：
  1. 直接使用 SigV4 签名的 HTTP 请求（服务端到服务端）
  2. 生成预签名 URL 交给浏览器 <img> 或前端使用

用法：
  export FUNCTION_URL="https://<id>.lambda-url.<region>.on.aws/"
  python3 invoke-python.py signed  photos/cat.jpg 400 300
  python3 invoke-python.py presign photos/cat.jpg 400 300 3600
"""
import os
import sys
import subprocess

import boto3
import requests
from botocore.auth import SigV4Auth, SigV4QueryAuth
from botocore.awsrequest import AWSRequest

FUNCTION_URL = os.environ["FUNCTION_URL"].rstrip("/")
REGION = os.environ.get("AWS_REGION", "ap-northeast-1")


def build_url(key: str, width: int, height: int, fmt: str = "webp") -> str:
    return (
        f"{FUNCTION_URL}/?key={key}"
        f"&width={width}&height={height}&format={fmt}"
    )


def signed_get(key: str, width: int, height: int) -> None:
    """服务端直接调用：每次请求实时 SigV4 签名。"""
    url = build_url(key, width, height)
    creds = boto3.Session().get_credentials().get_frozen_credentials()

    req = AWSRequest(method="GET", url=url, data=b"")
    SigV4Auth(creds, "lambda", REGION).add_auth(req)

    r = requests.get(url, headers=dict(req.headers), timeout=30)
    r.raise_for_status()

    out = "out.webp"
    with open(out, "wb") as f:
        f.write(r.content)
    print(f"HTTP {r.status_code}  Content-Type: {r.headers.get('content-type')}")
    print(f"X-Cache: {r.headers.get('x-cache')}")
    print(f"saved: {out} ({len(r.content)} bytes)")


def presign(key: str, width: int, height: int, expires: int = 3600) -> str:
    """生成预签名 URL：浏览器和前端可以直接使用，有效期最长 7 天。"""
    url = build_url(key, width, height)
    creds = boto3.Session().get_credentials().get_frozen_credentials()

    signer = SigV4QueryAuth(creds, "lambda", REGION, expires=expires)
    req = AWSRequest(method="GET", url=url, data=b"")
    signer.add_auth(req)
    return req.url


def main() -> None:
    if len(sys.argv) < 5:
        print(__doc__)
        sys.exit(1)

    mode = sys.argv[1]
    key = sys.argv[2]
    width = int(sys.argv[3])
    height = int(sys.argv[4])

    if mode == "signed":
        signed_get(key, width, height)
    elif mode == "presign":
        expires = int(sys.argv[5]) if len(sys.argv) > 5 else 3600
        print(presign(key, width, height, expires))
    else:
        print(f"unknown mode: {mode}", file=sys.stderr)
        sys.exit(2)


if __name__ == "__main__":
    main()
