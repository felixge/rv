# Agent notes

- Never migrate persisted data (cache files under the rv cache directory, browser storage). When a format changes, bump `VERSION` in `server/state.js`: files from other versions are ignored and rv starts from scratch. Don't add compatibility code for old data.
