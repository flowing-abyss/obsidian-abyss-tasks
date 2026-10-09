import { projectSearchText } from '../../../markdown/searchText';
import type { TaskSearchDocument, TaskSearchSourceNode } from '../../application/TaskSearchSource';
import type { TaskNodeSnapshot } from '../../domain/taskDependencies';
import { taskSearchMetadata } from '../../domain/taskSearchMetadata';

/** Adapt the borrowed canonical node during the owner's linear walk; never resolve its refs. */
export function taskSearchDocument(
  coordinate: TaskSearchSourceNode,
  node: TaskNodeSnapshot['node'],
): TaskSearchDocument {
  const title = projectSearchText(node.markdownTitle, 'title');
  const description = projectSearchText(node.description ?? '', 'prose');
  const comments = node.comments.map((comment) => projectSearchText(comment.text, 'prose'));
  return {
    ...coordinate,
    title: title.visible.text,
    description: description.visible.text,
    comments: comments.map((comment) => comment.visible.text).join('\n'),
    tags: node.tags.join(' '),
    metadata: taskSearchMetadata(node)
      .map(([, value]) => value)
      .join(' '),
    links: [title, description, ...comments]
      .flatMap((field) => field.destinations.map((value) => value.text))
      .join('\n'),
    sourcePath: coordinate.order.filePath,
  };
}
