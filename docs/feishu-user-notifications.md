# Personal Feishu notifications

The optional `feishu-user` Source reuses an existing personal `lark-cli` login to receive notifications in the Super Agent panel. It is separate from the upstream `feishu` bot Source, whose bot-only identity requirement is unchanged.

Enable the bundle entry `dsh-superagent-feishu-user` in the profile patch. Configure `source:feishu-user` through the panel or Management API:

```json
{
  "enabled": true,
  "config": {
    "cli": "/absolute/path/to/lark-cli",
    "account": "ou_operator",
    "mentions": true,
    "directMessages": true,
    "pollSeconds": 60
  }
}
```

Use `lark-cli whoami --as user` to obtain the operator's existing open_id. Setup verifies that the selected account matches the CLI identity. Every read rechecks both the app and user ID, so switching the CLI login cannot silently feed a different account into this Source. Credentials stay in the CLI's own secure storage; this integration neither copies nor decrypts them. Normal automatic token refresh is performed by the CLI when a user API call needs it. Account/CLI changes require the panel or Management API, not an agent settings tool.

In the tested CLI version (1.0.90), `event consume im.message.receive_v1` is bot-only. Personal notifications therefore use two read-only message searches per minute: group messages that mention the user, and personal direct messages. This is polling, not a push event subscription or a mirror of the Feishu client's unread badge. The integration does not send messages, change read state, join chats, enumerate old histories, download attachments or access documents/mail/calendar. An @all result is retained only when the returned message mentions the selected user's ID explicitly.

Each stream starts at activation. Subsequent searches replay a two-minute overlap to account for search-index delay, with stable message IDs preventing duplicate intake. The CLI sometimes renders creation times only to the local minute; range filtering accommodates that precision while the API's exact start/end bounds determine inclusion. Very long indexing delays may still require a manual historical search. Pagination is explicit; incomplete or repeated pages retain the previous cursor and report an error after three failed rounds. A successful stream advances independently of a failed one. Cursor keys include app ID, user ID and stream so accounts cannot share checkpoints.

Notifications appear under **Superagent → Messages**, grouped into Threads. The Source page shows health and intake counts. A message to the person is context, not an instruction addressed to the Agent: the Source does not mark it as addressed or observed for task admission and does not expose a task-originator allowlist. The initial configuration therefore records notifications without starting an Eval model call or Worker. Investigation and reply drafting require a separate explicit operator request through an authorized channel.

All replies for this Source are terminal local drafts. There is no send-mode option, and its outbound channel refuses direct sends. The shared outbox displays proposed text under **Local reply drafts** on the Source page, with no automatic replay. Workers receive a separate `lark-user-cli` shim that allows only read-only IM shortcuts with forced user identity and JSON output; writes, raw APIs, identity overrides and credential management commands are refused. As in upstream, shims are default-path guardrails rather than an OS sandbox, so the standing prompt also forbids bypassing them or copying private message content into public artifacts.

The existing GitLab Source, model selection and draft-only delivery settings can remain enabled alongside personal notifications. No bot app or new user authorization is required when the CLI already has the necessary personal message read/search permissions. If authorization expires or a scope is missing, repair the existing CLI authorization through its documented flow and recheck the Source.
