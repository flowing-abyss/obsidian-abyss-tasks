import { moment as hostMoment } from 'obsidian';

// Obsidian exports the callable host instance, but its namespace declaration loses
// call signatures under ES module interop. Preserve Moment's complete callable type.
// https://www.typescriptlang.org/tsconfig/esModuleInterop.html
export const moment = hostMoment as unknown as typeof window.moment;
