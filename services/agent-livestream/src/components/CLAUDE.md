> E2E verification requirements live in the flow graph — see flow skills via `npx agent-core search "flow/" --type skill`

# The conversation surface MUST be unified

This directory has been bitten twice by splitting one conversation
across multiple frontend components. **Read this before adding any
component that renders messages, transcriptions, or chat history.**

## The rule

There is **one** conversation view in this app. It renders user turns
and assistant turns — typed or spoken, text or voice — in a single
chronological list. There is **one** input surface — a composite mic
plus text field — that produces "user turn" events into **one** store.

You may not introduce:

- A second message-rendering component that subscribes to a different
  event stream than the canonical conversation view.
- A "transcript" pane that displays voice turns separately from typed
  turns.
- A standalone "chat panel" that posts text via a different path than
  voice input does.
- A polling hook for live updates while a session is active.
  (Polling for initial hydration only is allowed.)
- A second persistence call site for messages. There is one:
  `getServices().messages.create(chatId, role, text)`.

If you find yourself wanting any of those, stop and unify with the
existing surface instead. The reason this rule is strict is that we
shipped (and broke) the deployed preview twice with the disunified
shape: typed text wrote to the LiveKit data channel as a chat message
while the transcript pane subscribed to LiveKit transcriptions only,
so typed turns were invisible in the transcript. The DB-polling
history view rendered them eventually but on a 2-second lag and in a
different region of the screen. Users perceive the divergence as
"the chat doesn't work" — even though every individual surface is
technically functional in isolation.

## What "unified" means concretely

- A single component subscribes to **one** event stream — the LiveKit
  room's data channel — and feeds **one** in-memory conversation
  store. Voice transcriptions, typed user input, and the sub-agent's
  text and voice responses all arrive on the same channel.
- The component renders the conversation store. Role normalization is
  one vocabulary (`user` / `assistant` / `tool`) — never `agent` in one
  place and `assistant` in another.
- Initial page load hydrates the store from `/api/chats/:id/messages`
  once. After that, all updates come from the live stream. There is
  no `refetchInterval` for live messages.
- Speech and typed text both produce the same "user turn" event into
  the same store via the same code path. After speech is transcribed
  to text, the rest of the system cannot tell whether the turn
  originated as voice or typing.
- Persistence is one call site, invoked from one place in the
  sub-agent runtime. The frontend does not write messages directly.

## What this means for new tools

Tools (research, share_screen, future ones) emit artifact events on
the same data channel. Tool calls and tool results appear as turns in
the same conversation store, with role `tool` and a structured
payload. The conversation view renders them — possibly as a styled
chip or with an embedded artifact preview — but it is the same
component. Do not build a separate "tool log" panel.

## When to break this rule

You may not. If you have a use case that seems to require splitting
the surface, you have an architectural disagreement with this file —
escalate, do not fork. Two functioning surfaces is the bug; one
working surface is the goal.
