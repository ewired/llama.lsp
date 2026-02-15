# Llama LSP Server

A Language Server Protocol server providing inline code completions using a llama infill endpoint. Requires Deno, a running llama.cpp server with a model supporting the /infill endpoint, and an LSP client that supports `textDocument/inlineCompletion`.

## Configuration

All settings must be nested under the `llamaLsp` section (camelCase).

### Settings

- `llamaEndpoint` (default: `http://127.0.0.1:8012/infill`)
- `nPredict` (default: `128`)
- `temperature` (default: `0.0`)
- `topK` (default: `40`)
- `topP` (default: `0.90`)
- `debounceMs` (default: `150`)
- `tMaxPromptMs` (default: `500`)
- `tMaxPredictMs` (default: `1000`)

## Helix

**Note:** Requires a fork of Helix with PR #14876 (not yet merged). See: <https://github.com/helix-editor/helix/pull/14876>

Define the language server in `~/.config/helix/languages.toml`:

```toml
[language-server.llama-lsp]
command = "deno"
args = ["run", "-A", "jsr:@ewired/llama-lsp", "--stdio"]
```

Add `llama-lsp` to the `language-servers` array for each language in `languages.toml`:

```toml
[[language]]
name = "typescript"
language-servers = [ "typescript-language-server", "deno-lsp", "llama-lsp" ]
```

Configure settings globally (applies to all languages using this server):

```toml
[language-server.llama-lsp.config.llamaLsp]
llamaEndpoint = "http://127.0.0.1:8012/infill"
nPredict = 128
temperature = 0.0
```
