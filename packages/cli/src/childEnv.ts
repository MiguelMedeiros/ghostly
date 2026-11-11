/**
 * Environment variables only the command that reads them needs: the backup passphrase is read by a one-shot
 * `profile backup`/`profile restore` and sent as a call parameter, so no other process (the daemon, a hook, ffmpeg,
 * the translator, `ps`, `xattr`) ever needs it. The one list every child's environment is cleaned with.
 */
export const SECRET_ENV = ["GHOSTLY_BACKUP_PASSPHRASE"] as const;

/** `env` less the secrets in `SECRET_ENV`: what a process this one starts gets. */
export function childEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const rest = { ...env };
  for (const name of SECRET_ENV) delete rest[name];
  return rest;
}

/** Removes the secrets in `SECRET_ENV` from this process's own environment (the daemon, which never reads them). */
export function dropSecretEnv(env: NodeJS.ProcessEnv = process.env): void {
  for (const name of SECRET_ENV) delete env[name];
}
