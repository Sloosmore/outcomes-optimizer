# throwmail

CLI for managing email inboxes in agent workflows - receive emails, extract verification links/codes.

## Installation

```bash
npm install
npm run build
npm link  # Makes 'throwmail' available globally
```

## Usage

```bash
# Initialize an inbox
throwmail init                      # Random inbox
throwmail init --name "mytest"      # Named inbox

# Check for emails
throwmail list
throwmail read latest
throwmail count

# Wait for verification email
throwmail wait --timeout 60 --from "noreply"

# Extract verification content
throwmail extract-link
throwmail extract-code
```

## MVP Notice

This uses 1secmail.com, a **public** disposable email service. Inboxes are not private - anyone can check any address. This is suitable for testing and development, not production use.

## Architecture

```
src/
├── adapters/       # Email service backends (1secmail, future: mail.tm, SMTP)
├── commands/       # CLI command implementations
├── state/          # Inbox state management (~/.agent-email/)
└── utils/          # Extraction and polling utilities
```

The adapter pattern allows swapping backends without changing the CLI interface.

## Development

```bash
npm run build       # Compile TypeScript
npm run dev         # Watch mode
npm test            # Run tests
```
