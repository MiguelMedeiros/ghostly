import { Fragment } from "react";

/**
 * A command that wraps between its words only: a line never breaks inside `--label` after its dashes, which would read
 * as `--` and `label`. Each word is kept whole (`.ag-word`); the spaces between stay text, so the line may break there
 * and a selection copies the command as written.
 */
export function Cmd({ text }: { text: string }) {
  return (
    <>
      {text.split(" ").map((word, i) => (
        <Fragment key={i}>
          {i > 0 && " "}
          <span className="ag-word">{word}</span>
        </Fragment>
      ))}
    </>
  );
}
