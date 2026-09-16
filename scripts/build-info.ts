import { execFileSync } from 'node:child_process';
import { readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';

export interface BuildInfo { commit: string | null; committedAt: string | null; dirty: boolean }

function parse(value: unknown): BuildInfo {
  const info = value as Partial<BuildInfo>;
  if (typeof info?.commit !== 'string' || !/^[a-f0-9]{40,64}$/.test(info.commit) ||
      typeof info.committedAt !== 'string' || !/^\d{4}-\d{2}-\d{2}T/.test(info.committedAt) || !Number.isFinite(Date.parse(info.committedAt)) ||
      typeof info.dirty !== 'boolean') throw new Error('Invalid Stow build metadata. Supply a Git commit, commit date and dirty flag.');
  return { commit: info.commit, committedAt: info.committedAt, dirty: info.dirty };
}

export function buildInfo(source: string, supplied = process.env.STOW_BUILD_INFO): BuildInfo {
  if (supplied) return parse(JSON.parse(supplied));
  const git = (...args: string[]) => execFileSync('git', ['-C', source, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  let checkout = false;
  try { checkout = realpathSync(git('rev-parse', '--show-toplevel')) === realpathSync(source); } catch { /* An exported source archive has no Git directory. */ }
  if (checkout) {
    const [commit, committedAt] = git('show', '-s', '--format=%H%n%cI', 'HEAD').split('\n');
    return parse({ commit, committedAt, dirty: git('status', '--porcelain', '--untracked-files=normal') !== '' });
  }
  const archive = JSON.parse(readFileSync(path.join(source, 'build-version.json'), 'utf8'));
  // Git archive (also used by deployment) substitutes these fields. An arbitrary
  // source copy has no trustworthy revision; label that build honestly in the UI.
  if (archive.commit === '$Format:%H$' && archive.committedAt === '$Format:%cI$') return { commit: null, committedAt: null, dirty: false };
  return parse(archive);
}
