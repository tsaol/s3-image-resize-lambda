#!/usr/bin/env python3
"""End-to-end test suite for the image resize Lambda.
Exercises golden path + adversarial inputs (path traversal, oversize source,
extreme aspect ratio, missing / malformed keys).

Usage:
  ./test.py <function-url> [label]

Requires:
  pip install awscurl
"""
import sys, ast, time, subprocess, json, os

if len(sys.argv) < 2:
    print("Usage: test.py <function-url> [label]", file=sys.stderr)
    sys.exit(1)

URL = sys.argv[1]
LABEL = sys.argv[2] if len(sys.argv) > 2 else "?"
CACHE_BUCKET = os.environ.get(
    'CACHE_BUCKET',
    f"image-resize-cache-{subprocess.check_output(['aws','sts','get-caller-identity','--query','Account','--output','text']).decode().strip()}"
)
REGION = os.environ.get('AWS_REGION', 'ap-northeast-1')

def probe(qs=''):
    full = f"{URL}?{qs}" if qs else URL
    r = subprocess.run(
        ['awscurl', '--service', 'lambda', '--region', REGION, '-i', full],
        capture_output=True, timeout=60
    )
    raw = r.stdout
    idx = raw.find(b'\n')
    if idx < 0:
        return 0, {}, raw
    try:
        headers = ast.literal_eval(raw[:idx].decode())
    except Exception:
        headers = {}
    body = raw[idx+1:]
    ct = headers.get('Content-Type', '')
    if 'image/' in ct:
        return 200, headers, body
    if 'application/json' in ct:
        try:
            msg = json.loads(body).get('error', '')
            if 'too large' in msg.lower(): return 413, headers, body
            if 'not a supported' in msg.lower(): return 415, headers, body
            if 'not found' in msg.lower(): return 404, headers, body
            if 'internal' in msg.lower(): return 500, headers, body
            return 400, headers, body
        except Exception:
            return 400, headers, body
    return 0, headers, body

def head_object(key):
    r = subprocess.run(
        ['aws', 's3api', 'head-object', '--bucket', CACHE_BUCKET, '--key', key],
        capture_output=True
    )
    return r.returncode == 0

pass_, fail_ = 0, 0
def check(label, cond, note=""):
    global pass_, fail_
    if cond: print(f"  ✅ {label}  {note}"); pass_ += 1
    else:    print(f"  ❌ {label}  {note}"); fail_ += 1

print(f"\n{'=' * 68}\n {LABEL} — adversarial test suite\n{'=' * 68}")

print("\n[A] Golden path")
s, h, _ = probe("key=photos/cat.jpg&width=400&height=300&format=jpeg")
check("A1 jpeg resize", s == 200 and 'image/jpeg' in h.get('Content-Type', ''), f"→ {s}")
s, h, _ = probe("key=photos/cat.jpg&width=400&format=webp")
check("A2 webp resize", s == 200 and 'image/webp' in h.get('Content-Type', ''), f"→ {s}")
s, h, _ = probe("key=photos/cat.jpg&width=400&height=300&format=jpeg")
check("A3 cache HIT on repeat", h.get('x-cache') == 'HIT', f"→ x-cache={h.get('x-cache')}")

print("\n[B] Path traversal / key injection")
for label, qs, ok_range in [
    ("B1 non-image content-type", "key=photos/admin-keys.json&width=100", (400, 415)),
    ("B2 ../ traversal",           "key=../secret/keys.json&width=100",    (400, 400)),
    ("B3 absolute path",           "key=/etc/passwd&width=100",            (400, 400)),
    ("B4 URL-encoded traversal",   "key=..%2Fsecret%2Fkeys.json&width=100",(400, 400)),
    ("B5 outside allowed prefix",  "key=secret/keys.json&width=100",       (400, 400)),
    ("B6 special-char injection",  "key=photos/<script>&width=100",        (400, 400)),
    ("B7 nonexistent",             "key=photos/nothere.jpg&width=100",     (400, 404)),
]:
    s, h, _ = probe(qs)
    check(label, ok_range[0] <= s <= ok_range[1], f"→ {s}")

print("\n[C] Source-size guard")
s, h, _ = probe("key=photos/big.jpg&width=400&height=300&format=jpeg")
check("C1 huge source blocked", s == 413, f"→ {s}")

print("\n[D] Cache write correctness")
w = 500 + int(time.time()) % 100
qs_d = f"key=photos/cat.jpg&width={w}&height=200&format=jpeg"
cache_key = f"photos/cat.jpg/{w}x200_q80.jpeg"
s, h, _ = probe(qs_d)
check("D1 cache landed synchronously", head_object(cache_key), "")
s, h, _ = probe(qs_d)
check("D2 second call hits cache", h.get('x-cache') == 'HIT', f"→ x-cache={h.get('x-cache')}")

print("\n[E] Parameter validation")
s, _, _ = probe("key=photos/cat.jpg&width=99999")
check("E1 width > 4096", s == 400, f"→ {s}")
s, _, _ = probe("key=photos/cat.jpg&width=1&height=999")
check("E2 extreme aspect ratio", s == 400, f"→ {s}")
s, _, _ = probe("")
check("E3 missing key", s == 400, f"→ {s}")

print("\n[F] Content-type check on source")
s, h, _ = probe("key=photos/not-an-image.txt&width=100")
check("F1 text/plain source blocked", s in (400, 415), f"→ {s}")

print(f"\n{'=' * 68}\n {LABEL}: {pass_} pass / {fail_} fail\n{'=' * 68}")
sys.exit(0 if fail_ == 0 else 1)
