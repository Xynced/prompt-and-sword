# test/ — карта тестов

Запуск: `pnpm test`. Критерии валидационных ворот закодированы в тестах — их менять только осознанно.

| Файл | Что покрывает |
|---|---|
| [gate-a.test.ts](gate-a.test.ts) | **Ворота A**: разные IR-наборы → разные исходы; смена 1 правила меняет бой в ≥60% сидов; лог читается |
| [rng.test.ts](rng.test.ts) | mulberry32: детерминизм, распределение; shuffle |
| [grid.test.ts](grid.test.ts) | Дистанция (Чебышёв), lineBetween/hasLoS, фланг, достижимость |
| [terrain.test.ts](terrain.test.ts) | Схемы террейна валидны (спавны свободны, проходимость); камни в бою блокируют движение и LoS |
| [ir.test.ts](ir.test.ts) | evalCondition и resolveSelector по всем концептам MVP |
| [lens.test.ts](lens.test.ts) | Каждая линза как трансформация IR: plain, трус, фанатик, буквалист, мститель и остальные; тяга характера к видам действий (доли действий в бою) |
| [battle.test.ts](battle.test.ts) | Детерминизм (побайтовое совпадение лога), корректность боя, буквалист, фланг |
| *(scoring.ts — файла нет)* | Скоринг проверяется поведенчески через battle/ir/lens/концепт-тесты |
| [heroes.test.ts](heroes.test.ts) | Пул героев, способности, сборка партии |
| [foes.test.ts](foes.test.ts) | Поздние враги (шаман, берсерк, охотник) и разведка foeIntel |
| [constructor.test.ts](constructor.test.ts) | compilePhrase: чипсы → IR, закрытый концепт — ошибка |
| [cards.test.ts](cards.test.ts) | Карточки «как понял»: шаблоны, пометки искажений ⚠ |
| [deep-concepts.test.ts](deep-concepts.test.ts) | Глубокий словарь: условия, селекторы, скоринг, линзы, конструктор |
| [late-concepts.test.ts](late-concepts.test.ts) | Поздний словарь (приманка, размен, фланг…): то же по слоям |
| [mark.test.ts](mark.test.ts) | Метка и фокус-огонь: селектор marked, конструктор/схема, критерий «метка бьёт focus-leader» |
| [run.test.ts](run.test.ts) | Карта забега, состояние партии, трофеи, скрипторий, события, наёмник |
| [sparring.test.ts](sparring.test.ts) | Тот же seed + новые принципы → дифф; неизменённые принципы → тот же бой |
| [share.test.ts](share.test.ts) | Экспорт/импорт `ps1.…`: круговой цикл, валидация чужой строки |
| [balance.test.ts](balance.test.ts) | Автобаланс: бот играет забег, отчёт по слоям |
| [playtest.test.ts](playtest.test.ts) | Журнал плейтеста: события, cap, отчёт |
| [compiler.test.ts](compiler.test.ts) | LLM-компилятор на моках: схема из открытого словаря, **инъекции отбиваются** (критерий Ворот C), кэш |
