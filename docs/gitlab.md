# GitLab integration

This fork adds an optional GitLab Source to the upstream research prototype. DSH's GitHub Source remains available. GitLab can be the primary source without configuring GitHub. One GitLab host and project are watched per profile.

Enable `dsh-superagent-gitlab` in the profile patch and disable `dsh-superagent-github` for a GitLab-only profile. The installed plugin's package exports `dsh-superagent/gitlab-watch`. Build with `pnpm check` before linking the package into DSH.

Configure the Source in the panel, or save `source:gitlab` through the management settings API:

```json
{
  "enabled": true,
  "config": {
    "host": "gitlab.example.com",
    "repository": "group/subgroup/project",
    "cli": "/absolute/path/to/glab",
    "replyMode": "draft",
    "acceptOwnMentions": false,
    "observeIssues": false,
    "observeComments": false,
    "pollSeconds": 60
  }
}
```

Authenticate glab beforehand; the integration reuses that configuration and does not store a second token. Setup verifies the authenticated user and canonical project ID. Draft mode requires project read access; send mode requires Developer access. This CLI must use a personal access token available to `glab config get token --host HOST` if workers clone private repositories through the isolated Git credential helper; keyring-only credentials are not currently supported by that helper.

In the Policy settings, put the accounts allowed to originate work in `sources.gitlab.allowed`, as `[{"id":"username"}]`. Requests explicitly mention the authenticated agent account, for example `@agent-name please check this requirement`. Prefer a dedicated agent account. For an initial shared-account trial, enable `acceptOwnMentions`; unaddressed own messages, system notes and marked agent replies are skipped. GitLab identity is local to this Source and is never inferred from a GitHub or Feishu identity.

Polling starts at activation rather than ingesting old requests. It reads changed issues and merge requests, then their notes, including inline notes. Issue and MR IDs use separate namespaces. Intake is idempotent and cursors advance only after a successful round, with a five-second overlap. A failed read is retried; three failed rounds report an error. Context reads return a bounded root/notes page with continuation cursors. GitLab CI/pipeline transitions, approval events and group-wide or cross-project intake are not implemented in this first version.

With `replyMode: draft`, every acknowledgment, answer, question and result routed through the outbox is persisted with status `draft`. The Source page displays the complete proposed text under **Local reply drafts**. The remote channel is never invoked. Draft receipts are terminal: changing to `send` never sends old drafts. The mode is independent of the upstream Eval `observe` mode, which applies only to proactive acceptance and does not stop explicit-request replies.

Worker command shims additionally restrict glab to project API GET calls and refuse git push in draft mode. They are default-path guardrails, not an operating-system sandbox: agents run as the operator's OS user, as in upstream. Prompts must also state that drafts are not sent and that no remote service may be changed. Automatic mode changes through the agent settings tool are refused; account/mode changes require the panel/API.

In send mode, the outbox posts issue/MR notes with a hidden receipt marker, checks existing notes on retries, and binds MRs from the ticket branch to their ticket. A merged/closed owned MR ends its ticket. A missing private-project resource (404) remains retryable. The integration never merges an MR automatically. For an intake-only requirements repository, identify the actual implementation repository separately in the assignment and Execution prepare command.
