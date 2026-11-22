import { jsonOut } from "./jsonOut";

/**
 * A word as a hint offers it to be pasted into a shell: as it is when plain, else single-quoted. JSON's double quotes
 * are no shell quoting: `"$5 lunch"` pasted names ` lunch`, and a backtick in it runs a command. A leading `=` stays
 * quoted too (zsh expands `=word` to a command's path). Every "<name> (2)" a keep-both hint names has a `(` in it, a
 * syntax error in bash and zsh unquoted.
 *
 * The CLI prints every answer, an error too, as JSON, and a hint is pasted as the terminal shows it: a `'` quoted as
 * `'\''` read `'\\''` there, which ended the quote, and the rest of the word ran as commands (a group's name is its
 * inviter's, a kept-both file's its sender's). A `"` or a `\` came out doubled the same way. No shell quoting survives
 * that, so such a word is not offered: `instead` is said, an id that names the same thing or where the details hold it.
 */
export function shellWord(word: string, instead: string): string {
  if (/^[\w@%+:,./-][\w@%+=:,./-]*$/.test(word)) return word;
  return word.includes("'") || jsonOut(word) !== `"${word}"` ? instead : `'${word}'`;
}
