/** Fixed CommandMode chrome only. main supplies the host language; Node consumers default to English. */
const russian = {
  'Command needs attention. Press Q to continue.':
    'Нужно ваше внимание. Нажмите Q, чтобы продолжить.',
  'Command is waiting for your answer. Press Q to continue.':
    'Агент ждёт ответа. Нажмите Q, чтобы продолжить.',
  'Changes saved. Press Q to continue.': 'Изменения сохранены. Нажмите Q, чтобы продолжить.',
  'Command ready. Press Q to review.': 'Результат готов. Нажмите Q, чтобы посмотреть.',
  'Saved.': 'Сохранено.',
  'Saving…': 'Сохраняю…',
  'Working…': 'Думаю…',
  'Ready.': 'Готово.',
  'Waiting for your command.': 'Жду вашу команду.',
  'Ready for review.': 'Готово к проверке.',
  'Ready. Enter to save.': 'Готово. Enter — сохранить.',
  'Selected changes saved. The rest is pending.':
    'Выбранные изменения сохранены. Остальные ожидают сохранения.',
  'Status saved. Pending content is retained for review.':
    'Статус сохранён. Остальные изменения оставлены для проверки.',
  'Current work retained.': 'Текущая работа сохранена в черновике.',
  'Stopped. Your draft is retained.': 'Остановлено. Черновик сохранён.',
  'Draft discarded.': 'Черновик удалён.',
  'Prepare a fresh preview from the current source.':
    'Подготовьте новый предпросмотр по текущему источнику.',
  'Review this preview again.': 'Проверьте этот предпросмотр ещё раз.',
  'The source changed. Review a fresh preview.':
    'Источник изменился. Проверьте новый предпросмотр.',
  'Finish or reconcile the previous operation first.':
    'Сначала завершите или проверьте предыдущую операцию.',
  'The note preview is not ready to save.': 'Предпросмотр заметки ещё не готов к сохранению.',
  'Could not prepare the selected changes. Your proposal is retained.':
    'Не удалось подготовить выбранные изменения. Предложение сохранено.',
  'Could not save or record the result. Review the retained write journal before continuing.':
    'Не удалось сохранить или записать результат. Проверьте сохранённый журнал перед продолжением.',
  'The earlier result is unresolved. Acknowledge it before starting independent work.':
    'Результат предыдущей операции не выяснен. Подтвердите это перед началом новой работы.',
  'Keep this draft in history or discard it before starting a new session?':
    'Оставить черновик в истории или удалить перед началом новой сессии?',
  'Could not retain this session. Keep it open and try again.':
    'Не удалось сохранить сессию. Оставьте её открытой и повторите попытку.',
  'Save these changes, keep them for later, discard them, or stay here?':
    'Сохранить изменения, отложить, удалить или остаться здесь?',
  'Could not verify the requested selection.': 'Не удалось проверить выбранные объекты.',
  'That task changed. Read it again before opening it.':
    'Задача изменилась. Прочитайте её снова перед открытием.',
  'Opening task…': 'Открываю задачу…',
  'Choose at most five working entities.': 'Выберите не более пяти рабочих объектов.',
  'The project changed before it could be selected.': 'Проект изменился до завершения выбора.',
  'Use the exact current proposal and node for draft selection.':
    'Для выбора черновика нужны текущие предложение и узел.',
  'Only the current unsaved root can be discarded.':
    'Удалить можно только текущую несохранённую корневую задачу.',
  'Could not change the draft status.': 'Не удалось изменить статус черновика.',
  'This proposal is too large. Save or split it first.':
    'Предложение слишком большое. Сначала сохраните или разделите его.',
  'Resolve the previous write before changing this proposal.':
    'Проверьте предыдущую запись перед изменением предложения.',
  'This command is too long. Shorten it before sending; your full input is retained.':
    'Команда слишком длинная. Сократите её перед отправкой; весь текст сохранён.',
  'Read the complete task plan before staging it.':
    'Прочитайте весь план задачи перед подготовкой изменений.',
  'Refine the current note proposal to retain its pending sections.':
    'Уточните текущее предложение заметки, чтобы сохранить ожидающие изменения разделов.',
  'The project changed while its earlier edits were pending. Review them before continuing.':
    'Проект изменился, пока предыдущие правки ожидали сохранения. Проверьте их перед продолжением.',
  'Save or discard the pending changes to these notes before moving tasks. All current work is retained.':
    'Сохраните или отмените изменения этих заметок перед переносом задач. Вся текущая работа сохранена.',
  'Status uses ordinary completion, recurrence, deletion, timer and blocker rules after the content is saved.':
    'После сохранения содержимого статус применяет обычные правила завершения, повторения, удаления, таймера и блокировок.',
  'Save an API key for the selected provider.': 'Сохраните API-ключ выбранного провайдера.',
  'Could not access the API key in Obsidian secret storage.':
    'Не удалось получить API-ключ из хранилища секретов Obsidian.',
  'The provider rejected the API key or its permissions.':
    'Провайдер отклонил API-ключ или его разрешения.',
  'Check your provider billing or credits before trying again.':
    'Проверьте оплату или баланс провайдера перед повторной попыткой.',
  'The provider rate limit was reached. Try again later.':
    'Достигнут лимит запросов провайдера. Попробуйте позже.',
  'The provider request failed. Check the connection and try again.':
    'Запрос к провайдеру не выполнен. Проверьте соединение и повторите попытку.',
  'The provider returned an unreadable response.': 'Провайдер вернул нечитаемый ответ.',
  'The provider or model configuration is not supported.':
    'Настройки провайдера или модели не поддерживаются.',
  'The request was cancelled locally. Remote work may still finish.':
    'Запрос отменён локально. Удалённая обработка может завершиться.',
  'The provider took too long. Remote work may still finish.':
    'Провайдер не ответил вовремя. Удалённая обработка может завершиться.',
  'Earlier provider requests are still finishing. Try again shortly.':
    'Предыдущие запросы ещё завершаются. Повторите попытку чуть позже.',
  'The provider request or response exceeds the size limit.':
    'Запрос или ответ провайдера превышает допустимый размер.',
  'Recognizing speech…': 'Распознаю речь…',
  'Listening…': 'Слушаю…',
  'Voice is catching up. Wait, then use the microphone again.':
    'Обработка речи ещё идёт. Подождите и снова включите микрофон.',
  'Voice kept as text. Review before sending.':
    'Речь сохранена как текст. Проверьте перед отправкой.',
  'No clear speech recognized. Try again or type your command.':
    'Не удалось распознать речь. Повторите попытку или введите команду.',
  'Voice recognition took too long. Try the microphone again.':
    'Распознавание заняло слишком много времени. Включите микрофон снова.',
  'Untitled session': 'Сессия без названия',
  'Quick capture controls': 'Управление быстрым вводом',
  History: 'История',
  CommandMode: 'CommandMode',
  Microphone: 'Микрофон',
  Send: 'Отправить',
  Stop: 'Остановить',
  Cancel: 'Отмена',
  Command: 'Команда',
  'Could not start voice input': 'Не удалось запустить голосовой ввод',
  'What would you like to do?': 'Что вы хотите сделать?',
  'Could not retain command session': 'Не удалось сохранить сессию команд',
  'Add task': 'Добавить задачу',
  'Task name…': 'Название задачи…',
  'Continuous voice': 'Непрерывный голосовой ввод',
  'Continuous voice. Click to start or stop listening.':
    'Непрерывный ввод. Нажмите, чтобы начать или остановить запись.',
  'Finish recording, then edit and send the text.':
    'Завершите запись, затем отредактируйте и отправьте текст.',
  'Could not run command': 'Не удалось выполнить команду',
  'Could not stop command': 'Не удалось остановить команду',
  'Save proposal': 'Сохранить предложение',
  'Needs your answer.': 'Нужен ваш ответ.',
  'Could not display the note preview. Edit it or reopen CommandMode to retry.':
    'Не удалось показать заметку. Измените её или снова откройте CommandMode.',
  'Loading note preview…': 'Загружаю предпросмотр заметки…',
  'Could not open task': 'Не удалось открыть задачу',
  'New session': 'Новая сессия',
  'Could not start a new session': 'Не удалось начать новую сессию',
  'Save and continue': 'Сохранить и продолжить',
  'Keep for later': 'Отложить',
  'Discard draft': 'Удалить черновик',
  'Could not change session': 'Не удалось сменить сессию',
  'Review current source': 'Проверить текущий источник',
  'Could not review session': 'Не удалось проверить сессию',
  'Acknowledge uncertain result and start new': 'Подтвердить неизвестный результат и начать заново',
  'Could not retain uncertain result': 'Не удалось сохранить неизвестный результат',
  'Could not open session': 'Не удалось открыть сессию',
  'This note does not exist yet.': 'Эта заметка ещё не существует.',
  Note: 'Заметка',
  'Selected section': 'Выбранный раздел',
  'End of selection.': 'Конец выбранного содержимого.',
  'More content remains; ask to continue.': 'Есть ещё содержимое; попросите продолжить.',
  'Full note': 'Вся заметка',
  'Historical read · Current content unverified':
    'Историческое чтение · Текущее содержимое не проверено',
  'Written · Current content unverified · Proposed changes':
    'Записано · Текущее содержимое не проверено · Предлагаемые изменения',
  'Write outcome unverified · Proposed changes':
    'Результат записи не проверен · Предлагаемые изменения',
  'Could not display note content.': 'Не удалось показать содержимое заметки.',
  'New note · Complete preview': 'Новая заметка · Полный предпросмотр',
  'Changed sections · Complete preview': 'Изменённые разделы · Полный предпросмотр',
  'Changed section': 'Изменённый раздел',
  'New project': 'Новый проект',
  'Move to': 'Переместить в',
  'Unsupported status': 'Неподдерживаемый статус',
  'No status': 'Без статуса',
  'Unavailable property': 'Недоступное свойство',
  'Could not display property.': 'Не удалось показать свойство.',
  'Default status': 'Статус по умолчанию',
  'Could not render the task text.': 'Не удалось отобразить текст задачи.',
  'Could not focus this task': 'Не удалось выбрать эту задачу',
  'Could not expand the complete task tree.': 'Не удалось раскрыть всё дерево задачи.',
  'The selected changes no longer match this proposal. Review the current version.':
    'Выбранные изменения больше не соответствуют предложению. Проверьте текущую версию.',
  'These changes depend on other pending work. Include that work in this save?':
    'Эти изменения зависят от других ожидающих правок. Сохранить их вместе?',
  'This task needs its unsaved parent. Save the parent too, or keep both pending?':
    'Задаче нужен несохранённый родитель. Сохранить его тоже или оставить обе задачи в черновике?',
  'The selected write settled, but its remaining preview needs review. Do not repeat the write.':
    'Выбранная запись завершена, но оставшийся предпросмотр требует проверки. Не повторяйте запись.',
  'Continuation · {detail}': 'Продолжение · {detail}',
  '{part} excerpt · More content remains; ask to continue or read the full note.':
    'Фрагмент: {part} · Есть ещё содержимое; попросите продолжить или прочитать всю заметку.',
  '{part} · Complete selection': '{part} · Выбрано полностью',
  '{scope} · Complete preview': '{scope} · Полный предпросмотр',
  'Changed section · {label}': 'Изменённый раздел · {label}',
  'Select the saved root task before moving it. The previous focus and proposal are retained.':
    'Перед переносом выберите сохранённую корневую задачу. Предыдущий выбор и предложение сохранены.',
  'The proposal changed while this input was recorded. Review the current version before confirming.':
    'Предложение изменилось во время записи. Проверьте текущую версию перед подтверждением.',
  'Listen continuously, or transcribe for editing?':
    'Слушать непрерывно или записывать текст для редактирования?',
  'Continuous voice selected. Use the microphone to stop.':
    'Выбран непрерывный ввод. Микрофон останавливает запись.',
  'Dictation stays in the input for editing.': 'Диктовка остаётся в поле для редактирования.',
  'Keep the unsaved draft for later, or abandon it?':
    'Оставить несохранённый черновик на потом или удалить?',
  'Looking up the requested content…': 'Ищу нужное содержимое…',
  'Researching…': 'Ищу информацию…',
  'Stopped after the last admitted write. Review the result before continuing.':
    'Остановлено после последней принятой записи. Проверьте результат перед продолжением.',
  'The write settled, but a selected task is unavailable. Review the current result.':
    'Запись завершена, но выбранная задача недоступна. Проверьте текущий результат.',
  'The note was saved; the task link could not be verified. Review the current result.':
    'Заметка сохранена; ссылку в задаче проверить не удалось. Проверьте текущий результат.',
  'Related content changed after the earlier write. Review the remaining proposal before saving.':
    'Связанное содержимое изменилось после предыдущей записи. Проверьте оставшееся предложение перед сохранением.',
  'The earlier write invalidated the merge assessment. The source is retained for a fresh review.':
    'Предыдущая запись изменила условия объединения. Источник оставлен для повторной проверки.',
  'The note was saved, but the reviewed task link no longer matches.':
    'Заметка сохранена, но проверенная ссылка в задаче больше не соответствует ей.',
  'The note was saved, but its link could not be verified.':
    'Заметка сохранена, но проверить ссылку не удалось.',
  'The copied content needs review before removing its source.':
    'Проверьте скопированное содержимое перед удалением источника.',
  'The reviewed destination is unavailable.': 'Проверенное место назначения недоступно.',
  'The source preservation check no longer matches this proposal.':
    'Проверка сохранности источника больше не соответствует предложению.',
  'Stopped before the write was admitted. Your draft is retained.':
    'Остановлено до принятия записи. Черновик сохранён.',
  'The write result is unknown. Check the actual note before retrying.':
    'Результат записи неизвестен. Проверьте заметку перед повторной попыткой.',
  'The write receipt could not be verified. Do not repeat the write.':
    'Не удалось проверить подтверждение записи. Не повторяйте запись.',
  'The request may be partly saved. Review the actual result before continuing.':
    'Запрос мог сохраниться частично. Проверьте результат перед продолжением.',
  'The project write finished without a verified result.':
    'Запись проекта завершена без проверенного результата.',
  'The project changed again before it could be verified.':
    'Проект снова изменился до завершения проверки.',
  'The moved task could not be identified. Review the source and destination.':
    'Не удалось определить перенесённую задачу. Проверьте источник и место назначения.',
  'The moved task changed before it could be verified.':
    'Перенесённая задача изменилась до завершения проверки.',
  'The note write finished without a verified result.':
    'Запись заметки завершена без проверенного результата.',
  'The note was written, but its changed section could not be verified. Read the current note before continuing.':
    'Заметка записана, но проверить изменённый раздел не удалось. Прочитайте текущую заметку перед продолжением.',
  'The note changed before its edited section could be verified.':
    'Заметка изменилась до проверки отредактированного раздела.',
  'The write finished, but its resulting tasks could not be identified. Review the note.':
    'Запись завершена, но определить полученные задачи не удалось. Проверьте заметку.',
  'The selected task changed before it could be verified.':
    'Выбранная задача изменилась до завершения проверки.',
  'An affected hierarchy root could not be verified.':
    'Не удалось проверить затронутую корневую задачу.',
  'The task changed, but its final state could not be verified.':
    'Задача изменилась, но проверить итоговое состояние не удалось.',
  'The task changed before its current tree could be verified.':
    'Задача изменилась до проверки текущего дерева.',
  'The task ancestry could not be verified within its limit.':
    'Не удалось проверить цепочку родителей задачи в пределах лимита.',
  'Project settings changed. Review the retained requested values before saving.':
    'Настройки проекта изменились. Проверьте сохранённые запрошенные значения перед записью.',
  'Project settings could not be checked.': 'Не удалось проверить настройки проекта.',
  'The saved task has no exact correspondence. Review its status separately.':
    'Не удалось точно сопоставить сохранённую задачу. Проверьте её статус отдельно.',
  'This preview expired. Review a refreshed proposal before saving.':
    'Срок действия предпросмотра истёк. Проверьте обновлённое предложение перед сохранением.',
  'The request was stopped.': 'Запрос остановлен.',
  'The vault is still updating. Try again shortly.':
    'Хранилище ещё обновляется. Попробуйте чуть позже.',
  'This operation is unavailable.': 'Эта операция недоступна.',
  'This change was not saved. {detail} Your proposal is retained.':
    'Изменение не сохранено. {detail} Предложение сохранено.',
  You: 'Вы',
  Assistant: 'Помощник',
  Start: 'Начало',
  End: 'Конец',
  'Microphone unavailable. Try the microphone again.':
    'Микрофон недоступен. Попробуйте включить его снова.',
  'Voice input paused. Try the microphone again.':
    'Голосовой ввод приостановлен. Включите микрофон снова.',
  'Voice processing failed. Try the microphone again.':
    'Не удалось обработать речь. Включите микрофон снова.',
  'Could not use the microphone. Check permission and try again.':
    'Не удалось включить микрофон. Проверьте разрешение и повторите попытку.',
  'Recording is too large. Try a shorter command.':
    'Запись слишком большая. Попробуйте более короткую команду.',
  'Recording failed. Try the microphone again.': 'Запись не удалась. Включите микрофон снова.',
  'Recording reached one minute. Try a shorter command.':
    'Запись достигла одной минуты. Попробуйте более короткую команду.',
  'Recording could not finish. Try the microphone again.':
    'Не удалось завершить запись. Включите микрофон снова.',
  'No clear speech captured. Try again or type your command.':
    'Разборчивая речь не записана. Повторите попытку или введите команду.',
  'Recording could not restart. Try the microphone again.':
    'Не удалось возобновить запись. Включите микрофон снова.',
  'Could not release voice processing. Reopen CommandMode.':
    'Не удалось завершить обработку речи. Откройте CommandMode заново.',
  'Could not finish the recorder. Audio was discarded.':
    'Не удалось завершить запись. Аудио удалено.',
  'The task content change is invalid.': 'Изменение содержимого задачи недопустимо.',
  'The task content write could not be confirmed.':
    'Не удалось подтвердить запись содержимого задачи.',
} as const;
export type CommandMessage = keyof typeof russian;
let russianLocale = false;
export function configureCommandLocale(locale: string): void {
  russianLocale = locale.toLowerCase().split(/[-_]/)[0] === 'ru';
}
export function commandMessage(
  message: CommandMessage,
  values: Readonly<Record<string, string>> = {},
): string {
  const translated = russianLocale ? russian[message] : message;
  return translated.replace(
    /\{([a-z]+)\}/g,
    (literal: string, key: string) => values[key] ?? literal,
  );
}

/** Used only for application diagnostics, never user or model messages. */
export function commandDiagnostic(message: string): string {
  return Object.prototype.hasOwnProperty.call(russian, message)
    ? commandMessage(message as CommandMessage)
    : message;
}
