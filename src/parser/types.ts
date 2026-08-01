import type { OnCompletion, TaskPriority, TaskStatus } from '../tasks/domain/types';

export interface Task {
  filePath: string;
  line: number; // 0-based line index
  rawText: string; // full original line, for write-back
  tags?: string[]; // canonical semantic tags when projected from the task index
  text: string; // display text: metadata emoji and tags stripped
  markdownText: string; // display text with link markup ([[…]], [](…)) preserved
  status: TaskStatus; // 'in-progress' from checkbox '/' only; derived date logic lives in views
  statusSymbol: string; // raw char inside [ ]
  due?: string; // YYYY-MM-DD from 📅
  scheduled?: string; // YYYY-MM-DD from ⏳
  start?: string; // YYYY-MM-DD from 🛫
  completion?: string; // YYYY-MM-DD from ✅
  cancelledDate?: string; // YYYY-MM-DD from ❌
  time?: string; // HH:MM from ⏰
  duration?: number; // minutes, parsed from ⏱️
  recurrence?: string; // text after 🔁, e.g. "every week"
  onCompletion: OnCompletion;
  onCompletionExplicit: boolean;
  created?: string; // YYYY-MM-DD from ➕
  priority: TaskPriority;
  subtasks?: SubTask[];
  comments?: TaskComment[];
  description?: string;
  subtaskRange?: { from: number; to: number };
  linkCount?: number; // count of links (files/notes) in title+description+comments, precomputed by the task index
  dailyNoteDate?: string; // YYYY-MM-DD precomputed by the task index for daily-note files
  noteColor?: string; // from file frontmatter `color`
  noteTextColor?: string; // from file frontmatter `textColor`
  noteIcon?: string; // from file frontmatter `icon`
}

export interface SubTask {
  filePath: string;
  line: number;
  rawText: string;
  tags?: string[]; // canonical semantic tags when projected from the task index
  text: string;
  markdownText: string; // display text with link markup ([[…]], [](…)) preserved
  status: TaskStatus;
  statusSymbol: string;
  due?: string;
  scheduled?: string;
  start?: string;
  completion?: string;
  cancelledDate?: string;
  created?: string;
  time?: string;
  priority: TaskPriority;
  recurrence?: string;
  onCompletion: OnCompletion;
  onCompletionExplicit: boolean;
  subtasks?: SubTask[];
  comments?: TaskComment[];
  description?: string;
  subtaskRange?: { from: number; to: number };
}

export interface TaskComment {
  line: number;
  date?: string; // YYYY-MM-DD
  text: string;
}

export interface ParseContext {
  filePath: string;
  line: number;
  dailyNoteDate?: string; // pre-computed by store; parser stores it verbatim if provided
  globalTaskFilter?: string; // tag to strip, e.g. '#task'
  statusCatalog: import('../tasks/domain/StatusCatalog').StatusCatalog;
}
