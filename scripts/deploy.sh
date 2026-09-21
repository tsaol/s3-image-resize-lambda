#!/bin/bash
# Deploy the image resize Lambda to your AWS account.
# Prerequisites: aws CLI configured, Node.js 20+
#
# NOTE: This is DEMO / reference code. Test in a non-production account
# first and review IAM / concurrency / logging before real use.
set -euo pipefail

: "${AWS_REGION:=ap-northeast-1}"
: "${STACK_PREFIX:=image-resize}"

ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
ORIGINAL_BUCKET="${STACK_PREFIX}-original-${ACCOUNT_ID}"
CACHE_BUCKET="${STACK_PREFIX}-cache-${ACCOUNT_ID}"
FUNCTION_NAME="${STACK_PREFIX}"
ROLE_NAME="${STACK_PREFIX}-lambda-role"

echo "Deploying $FUNCTION_NAME to $AWS_REGION in account $ACCOUNT_ID"

# 1. Create S3 buckets (idempotent)
for B in "$ORIGINAL_BUCKET" "$CACHE_BUCKET"; do
  if ! aws s3api head-bucket --bucket "$B" 2>/dev/null; then
    aws s3api create-bucket --bucket "$B" --region "$AWS_REGION" \
      --create-bucket-configuration LocationConstraint="$AWS_REGION" >/dev/null
    aws s3api put-public-access-block --bucket "$B" \
      --public-access-block-configuration BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true
    aws s3api put-bucket-encryption --bucket "$B" --server-side-encryption-configuration \
      '{"Rules":[{"ApplyServerSideEncryptionByDefault":{"SSEAlgorithm":"AES256"}}]}'
    echo "  ✓ created $B"
  else
    echo "  = $B exists"
  fi
done

# 2. Cache bucket lifecycle: expire variants after 30 days
aws s3api put-bucket-lifecycle-configuration --bucket "$CACHE_BUCKET" --lifecycle-configuration '{
  "Rules": [{
    "ID": "expire-old-variants",
    "Status": "Enabled",
    "Filter": {"Prefix": ""},
    "Expiration": {"Days": 30}
  }]
}'

# 3. Create IAM role (idempotent)
if ! aws iam get-role --role-name "$ROLE_NAME" >/dev/null 2>&1; then
  cat > /tmp/trust-policy.json <<TRUSTEOF
{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"Service":"lambda.amazonaws.com"},"Action":"sts:AssumeRole"}]}
TRUSTEOF
  aws iam create-role --role-name "$ROLE_NAME" \
    --assume-role-policy-document file:///tmp/trust-policy.json >/dev/null
  echo "  ✓ created role $ROLE_NAME"
fi

cat > /tmp/lambda-policy.json <<POLICYEOF
{
  "Version": "2012-10-17",
  "Statement": [
    {"Effect": "Allow", "Action": "s3:GetObject", "Resource": "arn:aws:s3:::${ORIGINAL_BUCKET}/photos/*"},
    {"Effect": "Allow", "Action": ["s3:GetObject", "s3:PutObject"], "Resource": "arn:aws:s3:::${CACHE_BUCKET}/*"},
    {"Effect": "Allow", "Action": ["logs:CreateLogGroup", "logs:CreateLogStream", "logs:PutLogEvents"], "Resource": "arn:aws:logs:*:*:*"}
  ]
}
POLICYEOF
aws iam put-role-policy --role-name "$ROLE_NAME" \
  --policy-name least-privilege --policy-document file:///tmp/lambda-policy.json
echo "  ✓ IAM policy applied"

# 4. Build Lambda package
BUILD_DIR=$(mktemp -d)
cp index.mjs "$BUILD_DIR/index.mjs"
cp validateKey.mjs "$BUILD_DIR/validateKey.mjs"
cat > "$BUILD_DIR/package.json" <<PKGEOF
{"name":"image-resize","version":"1.0.0","type":"module","dependencies":{"sharp":"^0.33.5","@aws-sdk/client-s3":"^3.665.0"}}
PKGEOF
(cd "$BUILD_DIR" && npm install --platform=linux --arch=arm64 --libc=glibc --include=optional sharp @aws-sdk/client-s3 >/dev/null 2>&1)
(cd "$BUILD_DIR" && zip -qr /tmp/lambda.zip .)
echo "  ✓ built package $(du -h /tmp/lambda.zip | awk '{print $1}')"

# 5. Wait for IAM to propagate
sleep 5
ROLE_ARN=$(aws iam get-role --role-name "$ROLE_NAME" --query 'Role.Arn' --output text)

# 6. Deploy (create or update)
if aws lambda get-function --function-name "$FUNCTION_NAME" --region "$AWS_REGION" >/dev/null 2>&1; then
  aws lambda update-function-code --function-name "$FUNCTION_NAME" \
    --region "$AWS_REGION" --zip-file fileb:///tmp/lambda.zip >/dev/null
  aws lambda wait function-updated --function-name "$FUNCTION_NAME" --region "$AWS_REGION"
  echo "  ✓ code updated"
else
  aws lambda create-function --function-name "$FUNCTION_NAME" \
    --region "$AWS_REGION" \
    --runtime nodejs20.x --architectures arm64 \
    --role "$ROLE_ARN" --handler index.handler \
    --zip-file fileb:///tmp/lambda.zip \
    --timeout 29 --memory-size 1769 \
    --environment "Variables={ORIGINAL_BUCKET=$ORIGINAL_BUCKET,CACHE_BUCKET=$CACHE_BUCKET}" >/dev/null
  aws lambda put-function-concurrency --function-name "$FUNCTION_NAME" \
    --region "$AWS_REGION" --reserved-concurrent-executions 5 >/dev/null
  aws lambda wait function-active --function-name "$FUNCTION_NAME" --region "$AWS_REGION"
  echo "  ✓ function created"
fi

# 7. Function URL (idempotent)
if ! aws lambda get-function-url-config --function-name "$FUNCTION_NAME" --region "$AWS_REGION" >/dev/null 2>&1; then
  URL=$(aws lambda create-function-url-config --function-name "$FUNCTION_NAME" \
    --region "$AWS_REGION" --auth-type AWS_IAM --query FunctionUrl --output text)
else
  URL=$(aws lambda get-function-url-config --function-name "$FUNCTION_NAME" \
    --region "$AWS_REGION" --query FunctionUrl --output text)
fi

echo ""
echo "======================================"
echo " Deployed"
echo "======================================"
echo "Function:  $FUNCTION_NAME"
echo "URL:       $URL"
echo "Auth:      AWS_IAM (SigV4 signed requests only)"
echo ""
echo "Test:"
echo "  aws s3 cp your-image.jpg s3://$ORIGINAL_BUCKET/photos/"
echo "  awscurl --service lambda --region $AWS_REGION \\"
echo "    \"$URL?key=photos/your-image.jpg&width=400&height=300&format=webp\" \\"
echo "    > out.webp"
