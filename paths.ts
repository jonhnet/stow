import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const sourceDir = path.dirname(fileURLToPath(import.meta.url));
export const workspaceDir = path.dirname(sourceDir);
export const buildDir = path.join(workspaceDir, 'build');
export const defaultDataDir = path.join(workspaceDir, 'data');
export const distDir = path.join(buildDir, 'dist');
