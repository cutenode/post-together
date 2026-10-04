---
# auto is the default; it is spelled out because this file depends on it.
thread: auto
langs: [en]
---

This file is longer than one Bluesky post allows, so post-together splits it into a thread by itself. It breaks between paragraphs first, then between sentences, then between words, and it never breaks inside a link. The limit is 300 graphemes per post, so this is roughly where the [rendering rules in the README](https://github.com/cutenode/post-together#markdown-file-contract) would have been cut in half if the splitter did not know about links. Each post keeps the link facets that land in it, with byte offsets recomputed for the text it actually contains.
