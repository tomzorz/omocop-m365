# Why this server signs in as somebody else

Every Microsoft 365 MCP server ships the same first instruction: register an app, sign in. Almost none of them ask the only interesting question about that step: *as whom?*

This document is the answer this project settled on, and the reasoning behind it. It is opinionated, it is one person's threat model, and it changes what the server ships, including tools it deliberately does not have.

## 1. The default is wrong

The unexamined answer to "as whom" is "as you". Sign in with your Microsoft account, consent to the scopes, and the agent now operates your real mailbox, your real calendar, your files, and everything else your identity reaches.

Look at what that grant actually is. A language model, a component that can be steered by any text it reads and occasionally misunderstands, now holds live credentials to the accumulated state of your digital life, and it acts at machine speed. The mistake does not need to be dramatic. An incorrectly resolved name, a wrong id, a plausible-but-wrong reading of "clean this up", performed with your authority, in your name, on the only copy.

The common mitigation is to make the whole thing read-only. That trades away most of the usefulness and keeps most of the exposure: a read-only agent on your real mailbox can still read everything, still summarize your life to whoever successfully injects a prompt into it, and still cannot actually *do* anything for you.

## 2. A dedicated agent account

This server signs in as a dedicated agent account: a Microsoft account created for the agent, owning nothing that matters.

The point is not that the agent cannot write. It has full read/write, by design; an assistant that cannot act is a search box. The point is that everything it can reach is bounded by what that account owns, and that account owns nothing important. The worst possible outcome, account fully compromised and every scope abused, is the loss of a mailbox nobody depends on and a calendar built for the purpose.

That bound changes the risk calculus. "What if the model deletes the wrong thing?" stops being about *your* things. Write access stops being a nerve-wracking grant and becomes a cheap one. Read/write on a small blast radius beats read-only on a large one: safer, and more useful at the same time.

## 3. A wall with two known doors

A completely isolated account would be safe and useless; the agent could tell you nothing about your actual schedule. So the wall has exactly two doors, each deliberate, each one-directional:

- Your real calendar is shared to the agent account, read-only, inward. The agent can see your schedule. It cannot touch it.
- A managed calendar lives in your real tenant with write granted, outward. The agent creates, edits, and cancels events there. You see the result overlaid on your own calendar, and everything in it is undo-able by you, its owner.

## 4. Mail crosses nothing

The calendar has two doors. Mail has none: the agent's mailbox is its own, with no sharing in either direction. The asymmetry is deliberate, and it follows from what the two artifacts are.

A calendar entry is a proposal. It sits in a container its owner controls; if it is wrong, the owner deletes it and the world is restored. An email is an utterance. Once sent it exists in someone else's mailbox, under the sender's identity, and cannot be recalled.

So mail runs under the agent's own identity entirely: what it sends is visibly from the agent account, and what it reads is only what was sent to the agent account.

That second half has a consequence the agent itself must be honest about: "you have no email about X" is a lie it must never tell. A search that finds nothing has searched a mailbox that is not yours. The shipped email skill hammers this point, because a plausible-but-wrong answer about mail is worse than no answer.

## 5. Failing loudly beats failing silently

A design principle rather than an access decision, but it belongs here because silent failure is how access designs rot.

The worst behaviors in this class look helpful. A search that hits a Graph query restriction, catches the error, and returns the unfiltered inbox has *worked* by every observable signal, and it answered a different question than the one asked. A "delete the series" that quietly deletes one occurrence has done something reversible-looking with irreversible intent.

So: no Graph error is ever swallowed. The query builder encodes Graph's combination rules and says in prose what it had to give up ("ordered by relevance rather than date, because a text search was used"). Ambiguity refuses rather than guesses: a recurring event with no stated scope, a folder name matching twice, a series edit missing the data to target the series. Every refusal explains itself and names the way forward.

### What none of this prevents

Prompt injection. The HTML-to-Markdown conversion strips markup for readability and token cost; it does not make mail content safe to obey, and visible plain text is all an injection needs. The control for that lives above this server, in the client: mail content is data, never instructions, and the shipped skills state it as a standing rule. What the account boundary contributes is only this: when an injection succeeds anyway, it succeeds inside the agent account's small world, not your life.

## 6. The wider principle

None of this is specific to Microsoft 365. The pattern applies to anything an agent authenticates against: give the agent its own identity, keep that identity's world small, and name every place where its world touches yours.

The portable test: anything an agent authenticates with should be an identity you would be willing to revoke on ten minutes' notice. If revoking the credential would disrupt your life, the agent is holding too much of it. The agent account here passes. Disable it and you have lost a to-do list's worth of state and an afternoon of setup.

## 7. What it costs

Written plainly, because a rationale that hides its costs is advocacy.

- Two accounts to run. A second Microsoft account with a real password, security info, and occasional upkeep, plus the Azure app registration on top.
- Calendar reads are client-side work. Your schedule is two calendars now; the agent reads both and merges. The default calendar of the agent account is a third, mostly-empty thing that invitations land in.
- Mail from your agent is mail from a stranger. Recipients see an address they do not recognize. Every message needs to say whose agent it is, and some will be ignored or marked as spam anyway.
- Replies land where nobody looks. The agent's inbox is not in your routine. A reply that matters has to be fetched deliberately, or missed.
- Sharing has edges. Calendar sharing between accounts flattens some detail, and some Graph capabilities behave differently on shared resources than on owned ones. The two-door design lives inside those limits.
- Setup is longer than "sign in". This document, the setup guide, and an Azure registration versus one OAuth prompt.

If those costs read as unacceptable, the design is not for you. The honest alternative is not "sign in as yourself and hope"; it is a narrower grant on your real account with your eyes open (and, on a real tenant, the next section).

## 8. On a real tenant, you would do this properly

This design is the personal-account version of a pattern enterprises have real machinery for. On an organizational tenant, the industrial form is app-only authentication scoped to specific mailboxes: the application authenticates as itself (client credentials, no user), and Exchange Online restricts which mailboxes its application permissions actually reach, historically via application access policies, more recently via RBAC for applications. Either way, a permission that looks tenant-wide gets pinned to named resources. Same idea, enforced by the platform instead of by account boundaries: the credential the automation holds reaches exactly the resources someone chose to list, and nothing else.

A personal Microsoft account has none of that machinery. No app-only grants, no access policies. The dedicated agent account is how you get the same property with the tools a personal account actually has: if the platform will not scope the credential, hold a credential whose entire world is the scope.

## 9. One person's threat model, not security advice

This document describes a working setup built against one person's threat model: a personal assistant, on personal infrastructure, where the main concerns are model mistakes and injected instructions, and where the convenience of read/write access is worth engineering for rather than refusing. It is not a claim of completeness, not hardened against a targeted attacker, and not advice for handling anyone's data but your own.

If your threat model is different (regulated data, other people's mail, adversaries who know your name), start from the enterprise machinery in section 8 and a security review, not from a hobbyist document that says "blast radius" a lot.

What transfers, if anything does, is the question this started with. When a tool asks you to sign in, ask: *as whom?* And whether the identity you are about to hand over is one you could revoke in ten minutes without flinching.
