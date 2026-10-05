Surgical save check
===================

<!-- This comment is invisible in the editor. It must survive every test. -->

[![badge](https://img.shields.io/badge/linked-badge-blue?a=1&b=2)](https://example.com)

## 1. Open and close

Open this file in Prosedown, type nothing, close it. `git diff` must be empty.

## 2. Edit one word

EDIT ME: change this word.

After saving, `git diff` must show only the line above.

## 3. These must never change unless you edit them

* star bullet one
* star bullet two

| Script | Purpose |
|---|---|
| a.sh | unpadded table |

<img src="a.png" width="200">

This paragraph is hard-wrapped
across three short lines
on purpose.

See the [reference link][ref].

[ref]: https://example.com/reference

## 4. Add and delete

Add a new paragraph below this one, save, check the diff. Then delete it again.

DELETE ME: remove this whole paragraph, save, check the diff.

Last line, no changes expected here.
