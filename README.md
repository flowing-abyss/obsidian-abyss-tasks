# Abyss Tasks

A task management interface for Markdown tasks in Obsidian.

Abyss Tasks reads the tasks written in your notes and brings them into one view. Pick a list or a
tag on the left, work through its tasks in the middle, and edit the selected task on the right.
Every change is written back to your notes.

## Features

- Lists for Inbox, Today, and Upcoming, plus your pinned tags, tags, and projects.
- A calendar with day, week, and month views.
- Projects as a table, a kanban board, or a timeline.
- Recurring tasks, dependencies between tasks, sub-tasks, priorities, and custom statuses.
- Time tracking with a timer you can pause and resume.
- Search across all tasks, and hotkeys you can change.

## Installation

Abyss Tasks is not in the community plugin directory yet. To install it manually:

1. Download `main.js`, `manifest.json`, and `styles.css` from the
   [latest release](https://github.com/flowing-abyss/obsidian-abyss-tasks/releases/latest).
2. In your vault, create the folder `.obsidian/plugins/abyss-tasks/` and put the three files in
   it.
3. Restart Obsidian and open **Settings → Community plugins**. If community plugins are off, turn
   them on, then turn on **Abyss Tasks**.

Abyss Tasks also comes with the
[Flowing Abyss vault](https://flowing-abyss.com/Description-of-Obsidian-Vault).

## Usage

1. Open the command palette and run **Abyss Tasks: Open view**. The view opens in a new tab, or
   comes forward if it is already open. You can drag its tab into a sidebar.
2. Write tasks as `- [ ]` checkboxes in your notes, for example `- [ ] Call the bank 📅 2026-10-01`.
   The **Archive file** and notes that match **Ignored task sources** in Settings are skipped.
   Dates, priorities, and repeat rules use the emoji format of the Tasks plugin.
3. Switch between Tasks, Calendar, Projects, and Search with the buttons on the left edge.
4. Add a task with the **Add task** button below the list, and select a task to edit its details.
5. Change the first day of the week, the inbox source, tag groups, projects, custom statuses, and
   hotkeys in **Settings → Abyss Tasks**.

## Third-party notices

Abyss Tasks includes [rrule](https://github.com/jkbrzt/rrule) 2.8.1, distributed under this
licence:

```text
rrule.js: Library for working with recurrence rules for calendar dates.
=======================================================================

Copyright 2010, Jakub Roztocil <jakub@roztocil.name> and Lars Schöning

Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions are met:

    1. Redistributions of source code must retain the above copyright notice,
       this list of conditions and the following disclaimer.

    2. Redistributions in binary form must reproduce the above copyright
       notice, this list of conditions and the following disclaimer in the
       documentation and/or other materials provided with the distribution.

    3. Neither the name of The author nor the names of its contributors may
       be used to endorse or promote products derived from this software
       without specific prior written permission.

THIS SOFTWARE IS PROVIDED BY THE AUTHOR AND CONTRIBUTORS "AS IS" AND
ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED
WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
DISCLAIMED. IN NO EVENT SHALL THE AUTHOR AND CONTRIBUTORS BE LIABLE FOR
ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES
(INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES;
LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON
ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT
(INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF THIS
SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.



./rrule.js and ./test/tests.js is based on python-dateutil. LICENCE:

python-dateutil - Extensions to the standard Python datetime module.
====================================================================

Copyright (c) 2003-2011 - Gustavo Niemeyer <gustavo@niemeyer.net>
Copyright (c) 2012 - Tomi Pieviläinen <tomi.pievilainen@iki.fi>

All rights reserved.

Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions are met:

    * Redistributions of source code must retain the above copyright notice,
      this list of conditions and the following disclaimer.
    * Redistributions in binary form must reproduce the above copyright notice,
      this list of conditions and the following disclaimer in the documentation
      and/or other materials provided with the distribution.
    * Neither the name of the copyright holder nor the names of its
      contributors may be used to endorse or promote products derived from
      this software without specific prior written permission.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS
"AS IS" AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT
LIMITED TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR
A PARTICULAR PURPOSE ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT OWNER OR
CONTRIBUTORS BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL,
EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT LIMITED TO,
PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR
PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF
LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING
NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF THIS
SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
```

## License

[MIT](LICENSE)
