/**
 * Self-contained agent prompt that patches the `hermes mcp add` argparse
 * dest collision (where the flag's `--command` argument overwrites the
 * top-level dispatcher's `args.command`, so `mcp add --url ...` falls
 * through into `chat`).
 *
 * Shipped to the player as a copy-pasteable block in the Intro
 * troubleshooter — they hand it to their own agent, which performs the
 * patch on their machine. Kept in its own module so Intro.tsx doesn't
 * have to wear several hundred lines of escaped backticks.
 *
 * Don't edit casually: the wording is calibrated so a competent agent
 * runs it as-is without asking clarifying questions, and the escaped
 * backticks must stay escaped (they're literal markdown for the agent
 * to see, not template-literal interpolations).
 */
export const HERMES_FIX_PROMPT = `# Fix \`hermes mcp add\` launching chat instead of adding an MCP server

## Bug

Running \`hermes mcp add <name> --url <url>\` starts an interactive Hermes chat instead of registering the MCP server.

**Cause:** argparse \`dest\` collision in the Hermes CLI. The \`--command\` flag of \`mcp add\` writes into \`args.command\`, which the top-level dispatcher also uses to pick the subcommand. The MCP flag overwrites the dispatch value, so dispatch sees \`args.command is None\` and falls through to chat.

## Step 1 — Locate the package

The install path differs across systems (system Python, Homebrew, pipx, venv, asdf). Resolve it dynamically — do not hardcode any path.

\`\`\`
python3 -c "import hermes_cli, os; print(os.path.dirname(hermes_cli.__file__))"
\`\`\`

If that fails (the \`hermes\` CLI may use a different interpreter than \`python3\`), read the shebang of the \`hermes\` entry-point and use that interpreter:

\`\`\`
head -1 "$(command -v hermes)"
\`\`\`

Use the Python from the shebang to re-run the \`import hermes_cli\` line above.

Set:
- \`HERMES_DIR\` = resolved directory
- \`PYTHON\` = the interpreter that successfully imported \`hermes_cli\`

Target files:
- \`$HERMES_DIR/main.py\`
- \`$HERMES_DIR/mcp_config.py\`

## Step 2 — Patch \`main.py\`

Find:

\`\`\`
mcp_add_p.add_argument("--command", help="Stdio command (e.g. npx)")
\`\`\`

Replace with:

\`\`\`
mcp_add_p.add_argument("--command", dest="mcp_command", help="Stdio command (e.g. npx)")
\`\`\`

The CLI flag stays \`--command\`, but argparse now stores it in \`args.mcp_command\`, leaving \`args.command\` for the top-level dispatcher.

## Step 3 — Patch \`mcp_config.py\`

Inside \`cmd_mcp_add(args)\`, replace every read of the MCP stdio command from \`args.command\` with a local variable that reads the new dest first and falls back to the old one:

\`\`\`
command = getattr(args, "mcp_command", None) or getattr(args, "command", None)
\`\`\`

Use this local \`command\` variable everywhere \`args.command\` was previously read inside \`cmd_mcp_add\`, including guards such as:

\`\`\`
if not args.url and not args.command and not args.preset:
\`\`\`

which becomes:

\`\`\`
if not args.url and not command and not args.preset:
\`\`\`

## Step 4 — Permissions

Try writes without \`sudo\` first. On macOS Homebrew and pipx/venv installs, files are user-owned. On Linux system installs (\`/usr/lib\`, \`/usr/local/lib\`) they typically require \`sudo\` — only escalate if the unprivileged write fails.

## Step 5 — Verify

Compile both files with the same interpreter that imports \`hermes_cli\`:

\`\`\`
"$PYTHON" -m py_compile "$HERMES_DIR/main.py" "$HERMES_DIR/mcp_config.py"
hermes mcp add --help
\`\`\`

Compilation must be clean. \`hermes mcp add --help\` must print the help for the subcommand and exit, not launch chat.

## Constraints

- Do not modify anything outside the two files and the regions described above.
- Do not change the \`--command\` CLI flag name, only its argparse \`dest\`.
- Do not introduce new dependencies.

## Report back

- Resolved \`$HERMES_DIR\` and \`$PYTHON\`.
- The exact before/after lines changed in each file.
- Output of \`hermes mcp add --help\` after the patch.
`;
