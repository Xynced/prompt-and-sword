# src/ — карта модулей

Слои снизу вверх; зависимости направлены только вниз (боевое ядро ничего не знает о забеге и UI).

## Боевое ядро (детерминированное, чистые функции)

| Модуль | Что делает | Ключевые экспорты |
|---|---|---|
| [types.ts](types.ts) | Базовые типы: сторона, позиция, юнит, виды действий (включая обмен местами), оружие (урон/дальность на нём), площадные формы, классовые активы и пассивы, id линз | `Side`, `Pos`, `ActionKind`, `LensId`, `CombatUnit`, `WeaponSpec`, `AoeSpec`, `ActiveSpec`, `PassiveSpec` |
| [rng.ts](rng.ts) | Seeded RNG — единственный источник случайности | `mulberry32`, `shuffle` |
| [grid.ts](grid.ts) | Сетка 18×18: дистанция (Чебышёв), LoS, каменное укрытие, фланг, взвешенные обход и достижимость (бурелом/подъём — 2 очка) | `GRID_W/H`, `dist`, `hasLoS`, `hasTerrainCover`, `isFlanking`, `reachableTiles`, `EntryCost` |
| [terrain.ts](terrain.ts) | Поле из клеток со свойствами (камень/высота/опасность/бурелом), 12 арен-сценариев ASCII-схемами, пулы по тегам | `Tile`, `ArenaTag`, `TERRAIN_LAYOUTS`, `pickTerrain` |
| [tuning.ts](tuning.ts) | Константы баланса: урон, экономика хода, цены прикрытий, рипост, слабый инстинкт цели задачи, цена дороги (заслон/оборона/крюк) | `DMG_SCALE`, `expectedDamage`, `AP_PER_TURN`, `AP_VALUE`, `ACTION_BIAS_WEIGHT`, `WEAK_ATK_MULT`, `COVER`, `RIPOSTE_DMG`, `QUARRY_BIAS`, `INTERCEPT_APPEAL`, `DETOUR_APPEAL`, `TAUNT_PULL`, `APPEAL_FLOOR` |
| [ir.ts](ir.ts) | IR: правило «условие → предпочтение → вес», структурные пометки линз, условия-триггеры (hpAbove, firstBlood, leaderDown, wasHit) и условия про своих (наш держит вызов, наш в контакте, меня прикрывают, нашего обступили, наши навалились), комбинаторы условий `and`/`or` (глубокие чипсы), предпочтения внимания (taunt, lure), совместные (screen, regroup, swap) и рельефные (roughEdge, outflank), ссылка на своего по имени **или по роли** (раненый, передовой, наш стрелок, крикун, ближайший), вычисление условий, селекторов и ролей | `Rule`, `LensMark`, `Condition`, `Selector`, `Preference`, `AllyRef`, `AllyRole`, `ALLY_ROLE_RU`, `evalCondition`, `resolveSelector`, `resolveAlly` |
| [vocab.ts](vocab.ts) | Словарь концептов (86: условия, селекторы, действия, манера удара, темп, пространство, активы; вторая партия слов — условия под чипсы «и», контр-селекторы, добивание/фокус-огонь, гейты bless/feint; внимание — «вызывать на себя»/«уводить от X»; совместные действия — роли своих, условия про своих, заслон/строй/обмен местами; слова рельефа — «стеречь кромку»/«обходить из-за спин»); старт + обычные/редкие по данным аудита слов; изъятые из обращения | `ConceptId`, `CONCEPTS`, `STARTING_VOCAB`, `COMMON_WORDS`, `RARE_WORDS`, `RETIRED_WORDS`, `UNLOCKABLE` |
| [lens.ts](lens.ts) | Линзы характеров — детерминированные трансформации IR (10 в пуле): пометки marks, контекстные расщепления фраз, эмоциональный дрейф-защёлка, инстинкты (в т.ч. осторожность `caution` — видимость цены дороги) и тяга к видам действий | `applyLens`, `rollLenses`, `biasFor`, `ActionBias`, `MoodDrift`, `LENS_POOL`, `LENS_RU` |
| [scoring.ts](scoring.ts) | Utility-скоринг: выбор одного действия на очко хода, инстинкты + веса правил, высота/укрытие/опасность, осторожный шаг, толчок; кандидаты атак по каждому оружию, аффинность манер; касты АОЕ (залп/линия/ритуал, оценка групп, канал зон замаха); действующее прикрытие (чужое живо при смежном живом щитоносце); одна оборона за ход — сразу лучшая доступная; «держать позицию» — поводок (сопротивление растёт с удалением), а не якорь; «ждать» — темп (премия пасу, пока бой не докатился, и штраф сближению; любой явный приказ перебивает); стойки манер плана words («часто» крепче слабым, «наверняка» режет митигацию, приманка держит прикрытие); «добивать» (премия снимающему удару) и «бить туда же» (навал по цели своих); совместные действия — заслон от стрелков (тело рвёт линию выстрела), «сомкнуть строй» (зеркало интервала), обмен местами (премия по снятому давлению, нормированному на текущее hp подопечного); цена дороги — доступность цели приказа (заслон телохранителя, глухая оборона, крюк пути) множит тягу правила «атаковать», а при цели дороже доступной приказ переезжает на ту, что под рукой; слова рельефа — «стеречь кромку» (клетка у бурелома со стороны врага, на сам бурелом не ступать) и «обходить из-за спин» (боковое смещение от оси «наши → враги», штраф вышедшему вперёд своих) | `generateCandidates`, `decide`, `ActionKind`, `AP_COST`, `apCostFor`, `Decision`, `Factor`, `makeCtx`, `rangeAt`, `shoveDest`, `effectiveCover`, `targetAppeal`, `aoeDamage`, `castVictims`, `zoneDangerAt`, `ritualReady`, `weaponsOf`, `rageReady`, `wallReady`, `healReady`, `blessReady`, `shadowMult`, `retributionMult`, `attackMultFor`, `stanceOf`, `stanceAttackMult`, `stanceMitigation` |
| [battle.ts](battle.ts) | Прогон боя: инициатива, ходы по 3 очка действия, площадные касты (телеграф ритуала, залп в начале хода кастера), перехват телохранителя (подопечный разрешается по ссылке — имя или роль), обмен местами (клетки меняются, цену платит затевающий, опасная клетка бьёт обоих), рипост глухой обороны, дрейф-защёлка характеров (moodShift), event-sourced лог, превью спавнов; задачи боя (план objectives): killTarget / killBefore / survive, волны подкреплений в начале раунда, тег quarry цели | `runBattle`, `UnitSpec`, `BattleEvent`, `BattleResult`, `BattleSetup`, `Objective`, `Wave`, `spawnPreview` |
| [metrics.ts](metrics.ts) | Поведенческий отпечаток боя для статистики и сравнения | `fingerprint`, `Fingerprint` |

## Компиляция принципов (текст → IR → карточка)

| Модуль | Что делает | Ключевые экспорты |
|---|---|---|
| [constructor.ts](constructor.ts) | Конструктор фраз: `PhraseDraft` (чипсы словаря) → IR без LLM; условия «и»/«или» (комбинаторы), вложенные группы `if (a) { if (b) … }` → плоские правила; ссылка на своего именем или ролью (роль — отдельное слово); закрытый концепт — ошибка | `compilePhrase`, `compileNested`, `PhraseDraft`, `PhraseGroupDraft`, `CompileResult`, `ROLE_CONCEPT` |
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
| [foes.ts](foes.ts) | Фабрики 20 врагов (принципы в том же IR): ранние + 12 по мотивам pf2e для паттернов боёв (масса, стая, элита, лекарь, огр, тролль…) + ритуалист (план objectives) + разведка перед боем | `grunt`, `rat`, `wolf`, `slinger`, `soldier`, `sergeant`, `raider`, `bonesetter`, `ogre`, `pyro`, `thug`, `troll`, `duelist`, `ritualist`, …, `foeIntel` |
| [objectives.ts](objectives.ts) | Сценарии узлов (план objectives, волна 1): задача боя + состав + фикс-спавны героев на слой/слот — обезглавить (слой 1), разбитый лагерь (слой 3), сорвать ритуал (элитка 5), загонная охота волнами (слой 5) | `NodeScenario`, `scenarioForNode`, `RITUAL_DEADLINE`, `AMBUSH_WAVE_ROUND` |
| [run.ts](run.ts) | Забег: ветвящаяся карта 15 узлов, состояние партии, расстановка перед боем (сценарий может её фиксировать), скрипторий, события, босс; трофеи по редкости узла (урок — 2 обычных/1 редкое, бой — обычные, элита — редкие); бой узла получает задачу сценария; учебный бой можно пропустить (трофей тот же) | `generateMap`, `RunState`, `foesForNode`, `arenaForNode`, `setDeploy`, `skipLesson` |
| [debug.ts](debug.ts) | Debug-режим: каталог из 12 боёв узлов (все составы врагов и все сценарии), сборка забега из одного узла под заданный бой × партию 1–3 героев × любые характеры; headless-прогон для тестов и CLI | `DEBUG_BATTLES`, `DebugSetup`, `debugRun`, `debugBattle`, `debugBattleById`, `debugBrief`, `MAX_DEBUG_PARTY` |
| [sparring.ts](sparring.ts) | «Переиграть с теми же костями»: тот же seed, новые принципы, дифф исходов | `sparring`, `SparringDiff` |
| [share.ts](share.ts) | Экспорт/импорт билда строкой `ps1.…` (сид + словарь + принципы) | `exportBuild`, `importBuild` |
| [scenarios.ts](scenarios.ts) | Фиксированные IR-наборы и статы для Ворот A и CLI-прогонов | `makeIrSets`, `makeFoes`, `HERO_STATS` |
| [balance.ts](balance.ts) | Автобаланс: детерминированный бот играет забеги, статистика по слоям; на kill-задачах при открытом «вожаке» переписывается на фокус цели (и восстанавливает фразы после узла) | `playBotRun`, `balanceSweep`, `BalanceReport`, `objectiveRewrite` |
| [words-audit.ts](words-audit.ts) | Аудит слов (план words): дельта winrate слова/комбо к наив- и кайт-билдам по партиям × боям × сидам | `wordsAudit`, `AUDIT_ENTRIES`, `AUDIT_PARTIES`, `AUDIT_BATTLES`, `summarize`, `printAudit` |
| [playtest.ts](playtest.ts) | Журнал плейтеста: события поведения тестера, текстовый отчёт | `appendEvent`, `journalReport` |

## Входные точки

| Модуль | Что делает |
|---|---|
| [cli.ts](cli.ts) | `pnpm sim …`: gateA, run, debug, demo-run, balance, words-audit, compile, corpus |
| [ui/main.ts](ui/main.ts) | Весь веб-UI одним файлом (чистый DOM + Vite): карта, бой, конструктор (вложенные чипсы условий до трёх уровней со связкой «и»/«или»; якорь-союзник выбирается именем или ролью), спарринг, журнал; анимации действий в бою — всплывающие цифры урона/лечения, вспышки задетых клеток АОЕ (залп/линия/ритуал), значки прикрытий на фишках (прикрытие/глухая оборона/щит союзника), кадр обмена местами; панель задачи боя на узле и в бою, фикс-расстановка сценария, кнопка «пропустить урок»; тест-кнопки «debug» и «свободный режим» (весь словарь разом); панель отладки «собрать бой» — сценарий × партия × характеры |
| [ui/style.css](ui/style.css) | Стиль «полевой дневник тактика» |
