# Third-party code in pi-red-team

The UTF-8 boundary helpers `isUtf8Continuation`, `utf8SequenceLength`, and
`completeUtf8End` in `dist/thin/job-output.js` are adapted from
`ismailsaleekh/pi-background-tasks`, `src/core/host-api.ts`, commit
`799182ff65d7040732aea23b2001ea860b688531` (package version 2.6.10).
The file reader is adapted for incremental, job-bound cursors, no-follow opens,
and growing output files. No upstream registry or provider extension is loaded.

ISC License

Copyright (c) 2026

Permission to use, copy, modify, and/or distribute this software for any purpose
with or without fee is hereby granted, provided that the above copyright notice
and this permission notice appear in all copies.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES WITH
REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF MERCHANTABILITY AND
FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR ANY SPECIAL, DIRECT,
INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES WHATSOEVER RESULTING FROM LOSS
OF USE, DATA OR PROFITS, WHETHER IN AN ACTION OF CONTRACT, NEGLIGENCE OR OTHER
TORTIOUS ACTION, ARISING OUT OF OR IN CONNECTION WITH THE USE OR PERFORMANCE OF
THIS SOFTWARE.
