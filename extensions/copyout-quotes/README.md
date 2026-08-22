# copyout-quotes

Copy assistant output to your clipboard — like [pi-copy-output](https://github.com/jal-co/pi-copy-output), but with **markdown blockquote support**.

## Why

pi's TUI renders blockquotes with a `│` bar, and terminal selection can't grab
just the quote cleanly. This extension detects blockquotes in the raw markdown
of the last assistant response and copies exactly the quoted text:

- The `>` prefixes and their extra spacing are stripped.
- Inline markdown styling is **kept** (`**bold**`, `*italic*`, `` `code` ``,
  `[links](url)`), so the text pastes as proper markdown.
- Nested quote levels keep their inner `>`.
- Quotes inside fenced code blocks are ignored.

## Usage

```
/copyout        Open the picker: full response, sections, quotes, code blocks, tables
/copyout all    Copy the full conversation (no picker)
```

When a response has multiple blockquotes, each appears as `Quote 1`, `Quote 2`,
… with a preview of its first line. Select one and press enter to copy it.

Tables open a grid: arrow keys move, `enter` copies the cell, `r` row,
`c` column, `a` whole table, `esc` back.

## Notes

- Clipboard: `pbcopy` (macOS), PowerShell `Set-Clipboard` (Windows, UTF-8
  safe), `xclip` (Linux).
- Files: `index.ts` (extension + UI), `extract.ts` (pure parsing helpers,
  unit-testable).
