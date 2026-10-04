---
# Files whose name starts with "_" or "." are ignored, so this template is never posted.
# Copy it to a new name (for example 2026-10-01-release.md) and edit it.
#
# Every key is optional. Unknown keys and wrong types are errors that name the key and file.

# true skips the file entirely. Remove the key, or set it to false, when the file is ready.
draft: true

# Up to 3 BCP-47 language codes for the post's langs field. Default: none.
langs: [en]

# Override the post timestamp. Must parse as a date; it is re-serialised with toISOString().
# Default: the time of the run. Commented out here so a copied file does not carry a stale date.
# createdAt: 2026-09-28T09:00:00Z

# Link card: a URL, "auto" (the first link in the post; the default while link cards are
# enabled), or false. A post that has images never gets a card.
link: auto

# auto:   split text longer than 300 graphemes into a thread (the default)
# manual: split only on "---"; a post over the limit is an error
# off:    a single post; any "---" or overflow is an error
thread: auto
---

Body text goes here. It is Markdown; the README lists how each construct renders.

---

A `---` on its own line starts the next post of a thread.
