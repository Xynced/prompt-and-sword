# src/ — карта модулей

Слои снизу вверх; зависимости направлены только вниз (боевое ядро ничего не знает о забеге и UI).

## Боевое ядро (детерминированное, чистые функции)

| Модуль | Что делает | Ключевые экспорты |
|---|---|---|
| [types.ts](types.ts) | Базовые типы: сторона, позиция, юнит, виды действий, оружие (урон/дальность на нём), площадные формы, классовые активы и пассивы, id линз | `Side`, `Pos`, `ActionKind`, `LensId`, `CombatUnit`, `WeaponSpec`, `AoeSpec`, `ActiveSpec`, `PassiveSpec` |
| [rng.ts](rng.ts) | Seeded RNG — единственный источник случайности | `mulberry32`, `shuffle` |
| [grid.ts](grid.ts) | Сетка 18×18: дистанция (Чебышёв), LoS, каменное укрытие, фланг, взвешенные обход и достижимость (бурелом/подъём — 2 очка) | `GRID_W/H`, `dist`, `hasLoS`, `hasTerrainCover`, `isFlanking`, `reachableTiles`, `EntryCost` |
| [terrain.ts](terrain.ts) | Поле из клеток со свойствами (камень/высота/опасность/бурелом), 12 арен-сценариев ASCII-схемами, пулы по тегам | `Tile`, `ArenaTag`, `TERRAIN_LAYOUTS`, `pickTerrain` |
| [tuning.ts](tuning.ts) | Константы баланса: урон, экономика хода, цены прикрытий, рипост | `DMG_SCALE`, `expectedDamage`, `AP_PER_TURN`, `AP_VALUE`, `ACTION_BIAS_WEIGHT`, `WEAK_ATK_MULT`, `COVER`, `RIPOSTE_DMG` |
| [ir.ts](ir.ts) | IR: правило «условие → предпочтение → вес», структурные пометки линз, условия-триггеры (hpAbove, firstBlood, leaderDown, wasHit), вычисление условий и селекторов | `Rule`, `LensMark`, `Condition`, `Selector`, `Preference`, `evalCondition`, `resolveSelector` |
| [vocab.ts](vocab.ts) | Словарь концептов (45: условия, селекторы, действия, манера удара, темп, пространство, активы); старт + обычные/редкие по данным аудита слов; изъятые из обращения | `ConceptId`, `CONCEPTS`, `STARTING_VOCAB`, `COMMON_WORDS`, `RARE_WORDS`, `RETIRED_WORDS`, `UNLOCKABLE` |
| [lens.ts](lens.ts) | Линзы характеров — детерминированные трансформации IR (10 в пуле): пометки marks, контекстные расщепления фраз, эмоциональный дрейф-защёлка, инстинкты и тяга к видам действий | `applyLens`, `rollLenses`, `biasFor`, `ActionBias`, `MoodDrift`, `LENS_POOL`, `LENS_RU` |
| [scoring.ts](scoring.ts) | Utility-скоринг: выбор одного действия на очко хода, инстинкты + веса правил, высота/укрытие/опасность, осторожный шаг, толчок; кандидаты атак по каждому оружию, аффинность манер; касты АОЕ (залп/линия/ритуал, оценка групп, канал зон замаха); действующее прикрытие (чужое живо при смежном живом щитоносце); одна оборона за ход — сразу лучшая доступная; «держать позицию» — поводок (сопротивление растёт с удалением), а не якорь; «ждать» — темп (премия пасу, пока бой не докатился, и штраф сближению; любой явный приказ перебивает); стойки манер плана words («часто» крепче слабым, «наверняка» режет митигацию, приманка держит прикрытие) | `generateCandidates`, `decide`, `ActionKind`, `AP_COST`, `apCostFor`, `Decision`, `Factor`, `makeCtx`, `rangeAt`, `shoveDest`, `effectiveCover`, `aoeDamage`, `castVictims`, `zoneDangerAt`, `ritualReady`, `weaponsOf`, `rageReady`, `wallReady`, `healReady`, `blessReady`, `shadowMult`, `retributionMult`, `attackMultFor`, `stanceOf`, `stanceAttackMult`, `stanceMitigation` |
| [battle.ts](battle.ts) | Прогон боя: инициатива, ходы по 3 очка действия, площадные касты (телеграф ритуала, залп в начале хода кастера), перехват телохранителя, рипост глухой обороны, дрейф-защёлка характеров (moodShift), event-sourced лог, превью спавнов | `runBattle`, `UnitSpec`, `BattleEvent`, `BattleResult`, `spawnPreview` |
| [metrics.ts](metrics.ts) | Поведенческий отпечаток боя для статистики и сравнения | `fingerprint`, `Fingerprint` |

## Компиляция принципов (текст → IR → карточка)

| Модуль | Что делает | Ключевые экспорты |
|---|---|---|
| [constructor.ts](constructor.ts) | Конструктор фраз: `PhraseDraft` (чипсы словаря) → IR без LLM; закрытый концепт — ошибка | `compilePhrase`, `PhraseDraft`, `CompileResult` |
| [cards.ts](cards.ts) | Обратный перевод IR после линзы → карточка-эхо «как понял» (факт искажения до боя, полная карточка в debug) и реплики раскрытия для журнала боя | `understandingCard`, `lensQuip`, `driftQuip`, `ruleRu`, `describeWeapon`, `describeWeapons`, `describeActive`, `describePassives` |
| [compiler/schema.ts](compiler/schema.ts) | JSON-схема tool use из **открытого** словаря + программная валидация выхода | `buildCompileSchema`, `validateOutput`, `CompilerOutput` |
| [compiler/prompt.ts](compiler/prompt.ts) | Системный промпт компилятора (версионируется для ключа кэша) | `buildSystemPrompt`, `PROMPT_VERSION` |
| [compiler/compile.ts](compiler/compile.ts) | LLM-вызов: свободный текст → `PhraseDraft`, гейт через `compilePhrase` | `compileFreeText`, `anthropicModelCall`, `DEFAULT_MODEL` |
| [compiler/cache.ts](compiler/cache.ts) | Кэш компиляций по ключу текст+словарь+линзы+модель (память/localStorage) | `cacheKey`, `memoryCache`, `CompilerCache` |
| [compiler/cache-node.ts](compiler/cache-node.ts) | Файловый кэш для CLI (`.cache/compiler.json`) | `fileCache` |

## Забег и мета

| Модуль | Что делает | Ключевые экспорты |
|---|---|---|
| [heroes.ts](heroes.ts) | Пул из 16 героев — 8 классов pf2e × 2 варианта (класс-ярлык, оружие, актив, пассив, способность), сборка партии, дефолтные принципы | `HERO_POOL`, `pickParty`, `defaultPhrasesFor` |
| [foes.ts](foes.ts) | Фабрики 19 врагов (принципы в том же IR): ранние + 12 по мотивам pf2e для паттернов боёв (масса, стая, элита, лекарь, огр, тролль…) + разведка перед боем | `grunt`, `rat`, `wolf`, `slinger`, `soldier`, `sergeant`, `raider`, `bonesetter`, `ogre`, `pyro`, `thug`, `troll`, `duelist`, …, `foeIntel` |
| [run.ts](run.ts) | Забег: ветвящаяся карта 15 узлов, состояние партии, расстановка перед боем, скрипторий, события, босс; трофеи по редкости узла (урок — 2 обычных/1 редкое, бой — обычные, элита — редкие) | `generateMap`, `RunState`, `foesForNode`, `arenaForNode`, `setDeploy` |
| [sparring.ts](sparring.ts) | «Переиграть с теми же костями»: тот же seed, новые принципы, дифф исходов | `sparring`, `SparringDiff` |
| [share.ts](share.ts) | Экспорт/импорт билда строкой `ps1.…` (сид + словарь + принципы) | `exportBuild`, `importBuild` |
| [scenarios.ts](scenarios.ts) | Фиксированные IR-наборы и статы для Ворот A и CLI-прогонов | `makeIrSets`, `makeFoes`, `HERO_STATS` |
| [balance.ts](balance.ts) | Автобаланс: детерминированный бот играет забеги, статистика по слоям | `playBotRun`, `balanceSweep`, `BalanceReport` |
| [words-audit.ts](words-audit.ts) | Аудит слов (план words): дельта winrate слова/комбо к наив- и кайт-билдам по партиям × боям × сидам | `wordsAudit`, `AUDIT_ENTRIES`, `AUDIT_PARTIES`, `AUDIT_BATTLES`, `summarize`, `printAudit` |
| [playtest.ts](playtest.ts) | Журнал плейтеста: события поведения тестера, текстовый отчёт | `appendEvent`, `journalReport` |

## Входные точки

| Модуль | Что делает |
|---|---|
| [cli.ts](cli.ts) | `pnpm sim …`: gateA, run, demo-run, balance, words-audit, compile, corpus |
| [ui/main.ts](ui/main.ts) | Весь веб-UI одним файлом (чистый DOM + Vite): карта, бой, конструктор, спарринг, журнал; тест-кнопки «debug» и «свободный режим» (весь словарь разом) |
| [ui/style.css](ui/style.css) | Стиль «полевой дневник тактика» |
