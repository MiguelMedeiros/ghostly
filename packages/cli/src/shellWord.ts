/**
 * A word as a hint offers it to be pasted into a shell: as it is when plain, else single-quoted (a `'` in it escaped).
 * JSON's double quotes are no shell quoting: `"$5 lunch"` pasted names ` lunch`, and a backtick in it runs a command.
 * A leading `=` stays quoted too (zsh expands `=word` to a command's path). Every "<name> (2)" a keep-both hint names
 * has a `(` in it, a syntax error in bash and zsh unquoted.
 */
export function shellWord(word: string): string {
  return /^[\w@%+:,./-][\w@%+=:,./-]*$/.test(word) ? word : `'${word.replaceAll("'", "'\\''")}'`;
}
