// @ts-check
// Increase this version whenever a release changes the persisted data contract.
// Startup takes a backup before opening Store when this version or the app changes.
export const DATA_SCHEMA_VERSION = 46;
// Older data formats are no longer converted; such data is refused unchanged.
export const MIN_DATA_SCHEMA_VERSION = 40;
export const LOG_RETENTION = {
  days: 30,
  promptsPerCandidate: 2000,
  promptsTotal: 10000,
  promptCharacters: 128000,
  terminalFiles: 100,
  terminalBytes: 150000,
};
export function assertDataSchemaVersion(db) {
  const version = db.prepare('PRAGMA user_version').get().user_version;
  if (version > DATA_SCHEMA_VERSION)
    throw Error(
      'This data belongs to a newer AutoJob version. Install the current version; the data was not changed.',
    );
  if (
    version < MIN_DATA_SCHEMA_VERSION &&
    db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' LIMIT 1").get()
  )
    throw Error(
      'This data belongs to an old AutoJob version that is no longer supported; the data was not changed.',
    );
  return version;
}
export function markDataSchemaVersion(db) {
  db.exec(`PRAGMA user_version=${DATA_SCHEMA_VERSION}`);
}
export function prunePromptLogs(
  db,
  {
    now = Date.now(),
    days = LOG_RETENTION.days,
    perCandidate = LOG_RETENTION.promptsPerCandidate,
    total = LOG_RETENTION.promptsTotal,
  } = {},
) {
  for (const [name, value] of Object.entries({days, perCandidate, total}))
    if (!Number.isSafeInteger(value) || value < 1) throw Error(`Invalid log limit: ${name}`);
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='prompts'").get())
    return 0;
  const before = db.prepare('SELECT count(*) AS n FROM prompts').get().n;
  db.prepare('DELETE FROM prompts WHERE at<?').run(new Date(now - days * 86400000).toISOString());
  db.prepare(
    'DELETE FROM prompts WHERE seq IN (SELECT seq FROM (SELECT seq,row_number() OVER(PARTITION BY candidate_id ORDER BY seq DESC) AS n FROM prompts) WHERE n>?)',
  ).run(perCandidate);
  db.prepare(
    'DELETE FROM prompts WHERE seq NOT IN (SELECT seq FROM prompts ORDER BY seq DESC LIMIT ?)',
  ).run(total);
  return before - db.prepare('SELECT count(*) AS n FROM prompts').get().n;
}
