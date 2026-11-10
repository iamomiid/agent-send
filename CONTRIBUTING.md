# Contributing

Thanks for helping. Agent Send aims to stay small: request/reply between agents
you own, over files and one local process.

- **Bugs:** open an issue with steps to reproduce, your OS, Python version and
  the output of `agent-send doctor` (it never prints credentials).
- **New agent types or larger features:** open an issue to discuss before
  writing code.
- **Pull requests:** keep them focused and include tests.

```sh
uv sync
uv run pytest
uv run ruff check . && uv run ruff format --check .
```

Tests must not contact real agents or read real credentials. Use the fakes in
`tests/`.
