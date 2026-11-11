import type { ProjectPort } from '../projects/projectApi';
export const acceptProject = (port: ProjectPort): string => port.value;
