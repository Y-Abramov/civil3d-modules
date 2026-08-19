#!/usr/bin/env bash
set -euo pipefail

# Бакет общий с линейкой Robur (abrmove-modules) - civil3d живёт в своей
# папке bundle/, чтобы не пересекаться с Robur-каталогом в корне бакета
# и его папкой tpm/ (см. robur-modules/scripts/sync-to-yandex.sh - тот же
# приём, просто другой префикс и другое поле URL в catalog.json).
BUCKET="abrmove-modules"
PREFIX="bundle"
ENDPOINT="https://storage.yandexcloud.net"

rm -rf mirror
mkdir -p "mirror/$PREFIX/zip"

jq -c '.modules[]' catalog.json | while read -r entry; do
  bundle_url=$(echo "$entry" | jq -r '.bundle_url')
  filename=$(basename "$bundle_url")
  echo "Downloading $filename from $bundle_url"
  curl -fsSL -o "mirror/$PREFIX/zip/$filename" "$bundle_url"
done

# bundle_url в зеркальном catalog.json указывает на зеркальные же .zip -
# если GitHub недоступен для каталога, он недоступен и для скачивания.
jq --arg base "$ENDPOINT/$BUCKET/$PREFIX/zip" \
  '.modules |= map(.bundle_url = ($base + "/" + (.bundle_url | split("/") | last)))' \
  catalog.json > "mirror/$PREFIX/catalog.json"

echo "Uploading catalog.json"
aws s3 cp "mirror/$PREFIX/catalog.json" "s3://$BUCKET/$PREFIX/catalog.json" \
  --endpoint-url "$ENDPOINT" --acl public-read

echo "Uploading zip/ ($(ls "mirror/$PREFIX/zip" | wc -l) files)"
aws s3 sync "mirror/$PREFIX/zip" "s3://$BUCKET/$PREFIX/zip" \
  --endpoint-url "$ENDPOINT" --acl public-read
