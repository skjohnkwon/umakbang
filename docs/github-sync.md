# Sign in with GitHub, and sync the settings

Scope for a feature that is not built yet. Written against the code as it stands at 0.1.3.

## What it is

A **Sign in with GitHub** button in Settings. Once signed in, the part of umakbang that cannot
be reproduced - tags, ratings, notes, detected tempo and key, and the preferences - lives in a
secret gist on the user's own account, and every machine they sign in on ends up holding the
same thing.

## What it is not

- **Not a backup.** That is `.umak`, which carries the index, the probe cache and the
  waveforms, runs daily on its own, and is measured at 21.7MB for this library. None of that
  belongs in a gist and none of it is worth syncing: an index describes a disk, and the machine
  it lands on can rebuild it in one scan.
- **Not a sync of anything in `LOCAL_ONLY`.** `roots`, `windowBounds`, `lalalKey`,
  `keyCommand`, `outputDevice`, `bundleExportDir`, `developerMode` and `resetOnLaunch` describe
  one install and one machine. `exportBackup()` already strips them.
- **Not contracts or videos.** `umakbang-contracts.json` holds a legal name and purchaser
  details, `umakbang-videos.json` refers to recordings that exist on one machine only. Both are
  deliberately per-machine today and stay that way.

## Signing in: the device flow

A distributed desktop app cannot hold a client secret, and GitHub does not support PKCE for
OAuth apps, so the authorization-code flow is out. The device authorization grant needs only a
client id, which is public by design. It is what `gh` itself uses.

```
POST https://github.com/login/device/code        client_id, scope=gist
  -> user_code, verification_uri, device_code, interval, expires_in
POST https://github.com/login/oauth/access_token grant_type=urn:ietf:params:oauth:grant-type:device_code
  -> authorization_pending | slow_down | expired_token | access_denied | access_token
```

On screen: a short code such as `WDJB-MJHT`, already on the clipboard, and the browser opening
`github.com/login/device`. The app polls at the interval the response names, backs off on
`slow_down`, and stops on `expired_token`. There is no localhost listener and no custom
protocol callback, which is the whole reason to prefer this flow.

One OAuth app is registered once under the repo owner's account with **Enable Device Flow**
ticked. Its client id ships as a constant, the way `electron-builder.yml`'s `publish` block is
the one place the update feed is named, so a fork edits one value. A client id is not a
credential, so the updater's rule that nothing in the bundle is a secret is untouched.

Scope is `gist` and nothing else. `repo` would be read and write over everything the user owns,
which is an absurd price for a 300KB document. Note honestly in the UI that `gist` still means
read and write over *all* of the user's gists; GitHub has no narrower grant.

## Where the token lives

`safeStorage.encryptString`, which is DPAPI on Windows and the keychain elsewhere, written to
its own file:

```
userData/umakbang-account.json   { login, gistId, tokenCipher, lastVersion, lastSyncedAt }
```

Its own file, not `umakbang-data.json`, for two reasons that are both already invariants here:
that document is snapshotted every five minutes by `scheduleDataBackup` and copied verbatim
into every `.umak` bundle, and a credential inside a file people send each other is exactly
what `LOCAL_ONLY` exists to prevent. Nothing about `bundle.ts` or `auto-backup.ts` needs to
change as long as the token never enters `Settings`.

A 401 means the grant was revoked. That is a sign-in prompt, not an error notice.

## What is synced, and in what shape

The gist holds one file, `umakbang-settings.json`, whose contents are exactly what
`exportBackup()` returns today: a `SettingsBackup` at version 2, carrying `settings` with
`LOCAL_ONLY` stripped, `tags`, `ratings`, `notes`, `detectedBpm`, `detectedKey` and
`exportedRoots`.

Reusing that type is the single most valuable decision in this scope. It means the payload is
already understood by `importBackup()`, by `summariseBackup()`, by `remapBackup()` and by
`ImportWizard`, and that a synced document and an exported one can never drift apart.

**Size.** This library's document is a few hundred KB. The gists API truncates a file over 1MB
in its JSON response and sets `truncated: true` with a `raw_url` to fetch instead, so the
reader must handle both. Past about 10MB the API refuses the write, which a tagged library
could reach eventually; gzip plus base64 inside the JSON is the escape hatch and is worth
leaving a note for rather than building now.

## Sync semantics

The hard half. Three rules, in order.

**1. The whole document, last writer wins.** Not a per-key merge. `importBackup()` merges
today, which is right for an import and wrong for a sync: a merge cannot express a deletion, so
a tag removed on the laptop returns from the desktop's copy on the next pull and there is no
sequence of actions that removes it anywhere. Whole-document replacement propagates deletions,
and the gist's own git history is the undo.

**2. Conflicts are detected, never guessed.** The gists API has no `If-Match`, so concurrency is
check-then-act: read `history[0].version` before writing and compare it against the
`lastVersion` in the account file.

| local | remote moved | what happens |
| --- | --- | --- |
| clean | no | nothing |
| clean | yes | apply the remote document |
| dirty | no | push |
| dirty | yes | **ask**: keep mine, take theirs, or merge as a union |

"Dirty" is a flag set by the same `scheduleWrite` hook `scheduleDataBackup` already hangs off,
cleared on a successful push. The union option is exactly today's `importBackup()`, so the
safest answer is the one already written.

**3. Paths are checked before anything is written.** Every map is keyed by absolute path.
Compare the incoming `exportedRoots` against local `settings.roots`: identical sets mean the
mapping is the identity and the pull is silent, which is the two-machines-one-drive-letter case
and probably the common one. A different set must not be folded in automatically, because a
background sync cannot run a wizard and the failure mode is thousands of entries pointing at
folders that do not exist, which looks exactly like success.

## When it runs

- **Pull** on launch, after `initStore` and before the window loads, plus a manual Sync now.
- **Push** on the five-minute debounce that already triggers a data snapshot, and once from
  `flushStore` on quit, which covers a session shorter than the debounce.
- **Never during a scan**, the rule `auto-backup.ts` already follows and for the same reason:
  the launch scan is when the app is busiest and the payload is being read from the document
  the scan is writing.

## One footgun worth naming

Signing in on a fresh install pushes an empty document over months of tagging. The guard is a
sentence, not a merge: if the local document has no tags and no ratings and the remote has
some, refuse to push and offer to pull instead.

## Files

New:

```
src/shared/sync.ts          SyncStatus, SyncAccount, the payload alias over SettingsBackup
src/main/github-auth.ts     device flow, safeStorage, umakbang-account.json
src/main/sync.ts            pull, push, conflict detection, the schedule
src/renderer/src/lib/sync.ts   status publisher, subscribe/snapshot
```

Changed:

```
src/main/index.ts           init the module the way initUpdater/initAutoBackup are, IPC
src/main/store.ts           a dirty flag inside scheduleWrite, next to the snapshot hook
src/preload/index.ts        signIn, signOut, syncNow, account, onSyncStatus
SettingsPage.tsx            an Account section under Updates
```

Status is published from the module rather than through zustand, the shape `lib/updates.ts`
and `subscribeReprocess` already use, because a sync reports several times a second while it
runs and routing that through the store repaints the library for each tick.

## Phases

1. **Auth and manual sync.** Device flow, token storage, account row, Sync now, identical-roots
   only, refusing anything else with a sentence. This is the demo, and it is honest on its own.
2. **Automatic.** Push on the debounce and on quit, pull on launch, the conflict prompt, the
   empty-document guard.
3. **Different paths.** Persist a `FolderMapping` per remote root set, run `ImportWizard` once
   on a machine whose library sits elsewhere, and apply it silently after that.

Roughly a day each for 1 and 2, one to two for 3.

## Open questions

- Sign-in is per user, but is a document per *machine set* or per user? One gist per account is
  assumed here. Two libraries that should not merge would need two, which is a second decision
  and can wait until somebody has that problem.
- Whether the pull on launch should block the window. It should not; a sync that lands mid
  session is a store update like any other, and the tags it carries repaint through `revision`.
