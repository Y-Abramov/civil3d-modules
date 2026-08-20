#!/usr/bin/env bash
set -euo pipefail

# Бакет общий с линейкой Robur (abrmove-modules) - civil3d живёт в своей
# папке bundle/, чтобы не пересекаться с Robur-каталогом в корне бакета
# и его папкой tpm/ (см. robur-modules/scripts/sync-to-yandex.sh - тот же
# приём, просто другой префикс и другое поле URL в catalog.json).
BUCKET="abrmove-modules"
PREFIX="bundle"
ENDPOINT="https://storage.yandexcloud.net"

# Утилита первой установки: лежит в релизе Библиотеки модулей, в catalog.json
# её нет (это не модуль Стора). Сайт даёт её ссылкой на зеркало.
SETUP_EXE="AbrCivilSetup.exe"
SETUP_URL="https://github.com/Y-Abramov/abrcivilmodules/releases/latest/download/$SETUP_EXE"

# Раскладка зеркала плоская: bundle/<имя файла>. Так её ищет утилита установки
# (MirrorFallbackDownloader: «база зеркала + имя файла», полей в catalog.json нет),
# и так записано контрактом в civil3d/CLAUDE.md. Подпапку zip/ не заводить -
# фолбэк на зеркало сразу перестаёт находить пакеты.
rm -rf mirror
mkdir -p "mirror/$PREFIX/files"

jq -c '.modules[]' catalog.json | while read -r entry; do
  bundle_url=$(echo "$entry" | jq -r '.bundle_url')
  expected=$(echo "$entry" | jq -r '.bundle_sha256 // ""' | tr 'A-F' 'a-f')
  filename=$(basename "$bundle_url")
  target="mirror/$PREFIX/files/$filename"

  echo "Downloading $filename from $bundle_url"
  curl -fsSL -o "$target" "$bundle_url"

  # Зеркало не должно тиражировать подменённый или битый пакет: то, что уходит
  # в бакет, обязано совпасть с суммой из каталога - её же проверяет Стор
  # перед установкой. Нет суммы в каталоге - падаем, а не молча зеркалим.
  if [ -z "$expected" ]; then
    echo "ERROR: bundle_sha256 не задан для $filename" >&2
    exit 1
  fi
  actual=$(sha256sum "$target" | cut -d' ' -f1)
  if [ "$actual" != "$expected" ]; then
    echo "ERROR: sha256 не совпал для $filename" >&2
    echo "  ожидалось: $expected" >&2
    echo "  получено:  $actual" >&2
    exit 1
  fi
  echo "  sha256 ok"
done

# bundle_url в зеркальном catalog.json указывает на зеркальные же .zip -
# если GitHub недоступен для каталога, он недоступен и для скачивания.
jq --arg base "$ENDPOINT/$BUCKET/$PREFIX" \
  '.modules |= map(.bundle_url = ($base + "/" + (.bundle_url | split("/") | last)))' \
  catalog.json > "mirror/$PREFIX/catalog.json"

echo "Uploading catalog.json"
aws s3 cp "mirror/$PREFIX/catalog.json" "s3://$BUCKET/$PREFIX/catalog.json" \
  --endpoint-url "$ENDPOINT" --acl public-read

echo "Uploading bundles ($(ls "mirror/$PREFIX/files" | wc -l) files)"
aws s3 sync "mirror/$PREFIX/files" "s3://$BUCKET/$PREFIX" \
  --endpoint-url "$ENDPOINT" --acl public-read

# Установщик: пока ассет не приложен к релизу, шаг пропускается - каталог
# модулей от этого не страдает, workflow не должен падать из-за утилиты.
echo "Downloading $SETUP_EXE"
if curl -fsSL -o "mirror/$PREFIX/$SETUP_EXE" "$SETUP_URL"; then
  echo "  sha256: $(sha256sum "mirror/$PREFIX/$SETUP_EXE" | cut -d' ' -f1)"
  echo "  (сверить с sha256 на странице /modules/abr-civil-setup)"
  aws s3 cp "mirror/$PREFIX/$SETUP_EXE" "s3://$BUCKET/$PREFIX/$SETUP_EXE" \
    --endpoint-url "$ENDPOINT" --acl public-read
else
  echo "  WARNING: $SETUP_EXE нет в последнем релизе abrcivilmodules - пропускаю"
fi
