# civil3d-modules

Каталог модулей линейки ABR | CIVIL для Autodesk Civil 3D.

`catalog.json` читает `ABRSTORE` («Библиотека модулей») - список модулей,
версии, ссылки на .zip-релизы и их SHA-256.

Live: https://raw.githubusercontent.com/Y-Abramov/civil3d-modules/main/catalog.json

`downloads.json` — накопительный журнал скачиваний всех ассетов релизов модулей; его обновляет workflow `downloads` каждые 6 часов.
Учтённые скачивания никогда не уменьшаются: исчезнувшие ассеты и снятые с каталога модули сохраняются в журнале.
Ручные поправки за потерянную историю задаются в `scripts/downloads-offsets.json`.
Перед перезаливом ассета запустите workflow `downloads` вручную (Actions → Run workflow) и дождитесь завершения, чтобы журнал записал последнее число.
