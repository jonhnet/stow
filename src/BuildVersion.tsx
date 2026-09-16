import { BUILD_INFO } from './build-info';

export default function BuildVersion() {
  const { commit, committedAt, dirty } = BUILD_INFO;
  return <div className="settings-build" aria-label="Running build">
    <span>Build <code title={commit ?? undefined}>{commit?.slice(0, 10) ?? 'unversioned'}</code>{dirty && ' (modified)'}</span>
    {committedAt && <time dateTime={committedAt}>Committed {new Date(committedAt).toISOString().replace('T', ' ').replace('.000Z', ' UTC')}</time>}
  </div>;
}
