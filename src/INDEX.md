# src/ — карта модулей

Слои снизу вверх; зависимости направлены только вниз (боевое ядро ничего не знает о забеге и UI).

## Боевое ядро (детерминированное, чистые функции)

| Модуль | Что делает | Ключевые экспорты |
|---|---|---|
| [types.ts](types.ts) | Базовые типы: сторона, позиция, юнит, виды действий, id линз | `Side`, `Pos`, `ActionKind`, `LensId`, `CombatUnit` |
| [rng.ts](rng.ts) | Seeded RNG — единственный источник случайности | `mulberry32`, `shuffle` |
| [grid.ts](grid.ts) | Сетка 18×18: дистанция (Чебышёв), LoS, каменное укрытие, фланг, взвешенные обход и достижимость (бурелом/подъём — 2 очка) | `GRID_W/H`, `dist`, `hasLoS`, `hasTerrainCover`, `isFlanking`, `reachableTiles`, `EntryCost` |
| [terrain.ts](terrain.ts) | Поле из клеток со свойствами (камень/высота/опасность/бурелом), 12 арен-сценариев ASCII-схемами, пулы по тегам | `Tile`, `ArenaTag`, `TERRAIN_LAYOUTS`, `pickTerrain` |
| [tuning.ts](tuning.ts) | Константы баланса: урон, экономика хода, цены прикрытий | `DMG_SCALE`, `expectedDamage`, `AP_PER_TURN`, `AP_VALUE`, `ACTION_BIAS_WEIGHT`, `WEAK_ATK_MULT`, `COVER` |
| [ir.ts](ir.ts) | IR: правило «условие → предпочтение → вес», вычисление условий и селекторов | `Rule`, `Condition`, `Selector`, `Preference`, `evalCondition`, `resolveSelector` |
| [vocab.ts](vocab.ts) | Словарь концептов (37: условия, селекторы, действия, манера удара, пространство), стартовый/базовый/глубокий наборы | `ConceptId`, `CONCEPTS`, `STARTING_VOCAB`, `UNLOCKABLE` |
| [lens.ts](lens.ts) | Линзы характеров — детерминированные трансформации IR (10 в пуле), инстинкты и тяга к видам действий | `applyLens`, `rollLenses`, `biasFor`, `ActionBias`, `LENS_POOL`, `LENS_RU` |
| [scoring.ts](scoring.ts) | Utility-скоринг: выбор одного действия на очко хода, инстинкты + веса правил, высота/укрытие/опасность, осторожный шаг и толчок | `generateCandidates`, `decide`, `ActionKind`, `AP_COST`, `apCostFor`, `Decision`, `Factor`, `makeCtx`, `rangeAt`, `shoveDest` |
| [battle.ts](battle.ts) | Прогон боя: инициатива, ходы по 3 очка действия, event-sourced лог, превью спавнов | `runBattle`, `UnitSpec`, `BattleEvent`, `BattleResult`, `spawnPreview` |
| [metrics.ts](metrics.ts) | Поведенческий отпечаток боя для статистики и сравнения | `fingerprint`, `Fingerprint` |

## Компиляция принципов (текст → IR → карточка)

| Модуль | Что делает | Ключевые экспорты |
|---|---|---|
| [constructor.ts](constructor.ts) | Конструктор фраз: `PhraseDraft` (чипсы словаря) → IR без LLM; закрытый концепт — ошибка | `compilePhrase`, `PhraseDraft`, `CompileResult` |
| [cards.ts](cards.ts) | Обратный перевод IR после линзы → карточка «как понял» (искажения ⚠) | `understandingCard` |
| [compiler/schema.ts](compiler/schema.ts) | JSON-схема tool use из **открытого** словаря + программная валидация выхода | `buildCompileSchema`, `validateOutput`, `CompilerOutput` |
| [compiler/prompt.ts](compiler/prompt.ts) | Системный промпт компилятора (версионируется для ключа кэша) | `buildSystemPrompt`, `PROMPT_VERSION` |
| [compiler/compile.ts](compiler/compile.ts) | LLM-вызов: свободный текст → `PhraseDraft`, гейт через `compilePhrase` | `compileFreeText`, `anthropicModelCall`, `DEFAULT_MODEL` |
| [compiler/cache.ts](compiler/cache.ts) | Кэш компиляций по ключу текст+словарь+линзы+модель (память/localStorage) | `cacheKey`, `memoryCache`, `CompilerCache` |
| [compiler/cache-node.ts](compiler/cache-node.ts) | Файловый кэш для CLI (`.cache/compiler.json`) | `fileCache` |

## Забег и мета

| Модуль | Что делает | Ключевые экспорты |
|---|---|---|
| [heroes.ts](heroes.ts) | Пул героев со способностями, сборка партии, дефолтные принципы | `HERO_POOL`, `pickParty`, `defaultPhrasesFor` |
| [foes.ts](foes.ts) | Фабрики врагов (принципы в том же IR) + разведка перед боем | `grunt`, `warChief`, `shaman`, …, `foeIntel` |
| [run.ts](run.ts) | Забег: ветвящаяся карта 15 узлов, состояние партии, расстановка перед боем, скрипторий, события, трофеи, босс | `generateMap`, `RunState`, `foesForNode`, `arenaForNode`, `setDeploy` |
| [sparring.ts](sparring.ts) | «Переиграть с теми же костями»: тот же seed, новые принципы, дифф исходов | `sparring`, `SparringDiff` |
| [share.ts](share.ts) | Экспорт/импорт билда строкой `ps1.…` (сид + словарь + принципы) | `exportBuild`, `importBuild` |
| [scenarios.ts](scenarios.ts) | Фиксированные IR-наборы и статы для Ворот A и CLI-прогонов | `makeIrSets`, `makeFoes`, `HERO_STATS` |
| [balance.ts](balance.ts) | Автобаланс: детерминированный бот играет забеги, статистика по слоям | `playBotRun`, `balanceSweep`, `BalanceReport` |
| [playtest.ts](playtest.ts) | Журнал плейтеста: события поведения тестера, текстовый отчёт | `appendEvent`, `journalReport` |

## Входные точки

| Модуль | Что делает |
|---|---|
| [cli.ts](cli.ts) | `pnpm sim …`: gateA, run, demo-run, balance, compile, corpus |
| [ui/main.ts](ui/main.ts) | Весь веб-UI одним файлом (чистый DOM + Vite): карта, бой, конструктор, спарринг, журнал |
| [ui/style.css](ui/style.css) | Стиль «полевой дневник тактика» |
