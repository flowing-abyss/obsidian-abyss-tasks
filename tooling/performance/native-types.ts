import type { App } from 'obsidian';
import type {
  TaskApplicationApi,
  TaskCaptureApplicationApi,
  TaskDependencyQueryApi,
  TaskQueryApi,
  TaskSearchApi,
  TaskStatisticsSource,
  TimeTrackingQueryApi,
} from '../../src/tasks';

export interface ProfilePlugin {
  queries: TaskQueryApi & TaskDependencyQueryApi & TimeTrackingQueryApi;
  tasks: TaskApplicationApi & TaskCaptureApplicationApi;
  search: TaskSearchApi;
  taskStatistics: TaskStatisticsSource;
}

export interface Host extends App {
  plugins: {
    plugins: Record<string, ProfilePlugin | undefined>;
    enablePlugin(id: string): Promise<void>;
    disablePlugin(id: string): Promise<void>;
  };
  commands: { executeCommandById(id: string): boolean };
}

export type CdpListener = (
  event: unknown,
  method: string,
  params: Record<string, unknown>,
  sessionId?: string,
) => void;
interface DebuggerBridge {
  isAttached(): boolean;
  sendCommand(
    method: string,
    params?: Record<string, unknown>,
    sessionId?: string,
  ): Promise<unknown>;
  on(event: 'message', listener: CdpListener): void;
  removeListener(event: 'message', listener: CdpListener): void;
}
export interface NativeBridge {
  debugger: DebuggerBridge;
  save(name: string, data: unknown): void;
  saveImage(name: string, base64: string): void;
  matchesWorkerSource(source: string): boolean;
}
export interface NativeOptions {
  vault: string;
  fixtureFolder: string;
  anchor: string;
  startup: boolean;
  viewport: string;
}
