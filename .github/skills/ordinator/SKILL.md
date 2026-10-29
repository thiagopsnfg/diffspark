---
name: ordinator
description: "Sort import statements in ascending order by line length (shortest to longest). Use when: sorting imports, ordering imports by width, fixing import order, reordering import blocks, reorganizing ES6 imports, reviewing import style, correcting import sequence by character count."
argument-hint: "File path or code snippet containing the imports to sort"
---

# Sort Imports by Width

Sort every `import` statement in ascending order by **total line length** — shortest line first, longest last. This is a required convention enforced across this codebase.

If the input is a file path, read the file, apply the sort in place, and report the changed import blocks. If the input is a code snippet, return the full snippet with only the import blocks reordered.

## Rules

1. Measure each import statement's **character count** using only the code characters, from the first character of `import` through the trailing `;` (or the last code character if no semicolon is present). Exclude trailing comments and trailing whitespace. For multi-line imports, use the normalization defined in Edge Cases.
2. Sort the group **shortest → longest**.
3. Lines of **equal length** keep their relative order (stable sort).
4. **Each contiguous block** of imports is sorted independently. A blank line between imports marks a boundary — do not sort across it. Any non-import line (including comment lines such as `// ...`) between import statements ends the current block. Keep such lines in their original positions and do not move or sort them. Continuation lines within a multi-line import remain part of that statement.
5. Never change what is imported — only reorder the lines.
6. Do not auto-organize imports with Biome or any other tool; sort manually by line length.

## Procedure

### 1. Identify the import block

Find each contiguous group of `import` statements (blank lines or other non-import lines between statements = block boundaries). Handle each block separately. If no `import` statements are found, or the file cannot be read, respond with "No import statements found." and make no changes.

### 2. Measure each line

Count each statement's code characters as defined in the Rules, excluding trailing comments and trailing whitespace:

```js
import lib1 from "@package/other/lib1";          // 40 chars
import simply from "@package/lib0";               // 35 chars
import {lib3} from "@package/other/lib3";         // 41 chars
import dummy_text from "@package/other/other/lib2"; // 51 chars
import {letraset} from "@package/other/other/lib3"; // 51 chars
import specimenBook from "@package/lib1/other/other/lib1"; // 58 chars
```

### 3. Sort ascending

Reorder so the shortest line comes first:

```js
import simply from "@package/lib0";               // 35
import lib1 from "@package/other/lib1";           // 40
import {lib3} from "@package/other/lib3";         // 41
import dummy_text from "@package/other/other/lib2"; // 51
import {letraset} from "@package/other/other/lib3"; // 51
import specimenBook from "@package/lib1/other/other/lib1"; // 58
```

### 4. Verify

Before finishing, confirm:
- No import was dropped or duplicated
- No blank lines were introduced inside a block
- Only the order changed — no other edits

## Edge Cases

| Case | Rule |
|---|---|
| Named imports `{foo, bar}` | Treat the whole line as one unit; do not expand or reformat braces |
| Multi-line imports | Sort by the character count of the full statement with line breaks and indentation collapsed to single spaces, including the trailing `;` if present and excluding comments and trailing whitespace. Keep the full multi-line block together. |
| Side-effect imports `import "module"` | Sort together with other imports by line length |
| Type imports `import type {…}` | Sort together with value imports by line length |
| Blank lines between groups | Each group is sorted independently; blank-line boundaries are preserved |
| Ties (equal length) | Preserve original relative order |
