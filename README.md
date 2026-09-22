# rv

A small, local code review tool for turning feedback into a prompt for a coding
agent, using [@pierre/diffs](https://diffs.com) and
[@pierre/trees](https://www.npmjs.com/package/@pierre/trees).

There are many tools like this, but this one is customized to my preferences.

![Reviewing working-tree changes and collecting comments](docs/screenshots/review.png)

## What it does

- Reviews repository files, working-tree changes, recent commits, or a commit
  range in unified or split diffs.
- Attaches comments to individual lines or ranges and gathers them in one place.
- Tracks reviewed files and supports fast, keyboard-driven navigation.
- Copies every comment as a concise prompt with exact file and line references.
- Runs entirely on your machine: no account, database, telemetry, or source-code
  upload.

![Previewing the prompt generated from review comments](docs/screenshots/prompt.png)

## Run it

Requires Node.js 22+ and Git.

```sh
npm ci
npm run build
npm link
```

Then run `rv` inside any repository:

```sh
rv
```

rv opens a browser and serves a read-only review UI on localhost. Refresh the
page when you want to load new repository changes; nothing is written back to
the repository.

Use `rv --help` for directory, port, host, and browser options.

## Development

```sh
npm run build
npm test
npm run test:browser
```
