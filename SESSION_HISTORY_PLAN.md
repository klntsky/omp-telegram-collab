# Watched session history plan

Status: proposed. This document records the motivation and implementation route. The watcher and refresh behavior below are not implemented.

## 1. Motivation

The Mini App should open at the recent tail without downloading the full conversation to the browser. Older pages load on demand. The bot already stays connected to active OMP sessions, so its shared history index can keep that tail ready for later viewers.

The current `SessionFeed` indexes the initial Collab snapshot and subsequent `entry` frames. This is sufficient for append-only history. It is not sufficient when OMP changes an existing entry or removes one. An unchanged entry ID is deduplicated rather than replaced, and Collab does not broadcast a replacement history snapshot after every rewrite.

`/shake` is not the only source of changes. Native image removal, automatic tool-output pruning, and maintenance recovery paths can also rewrite earlier content. Detecting particular commands or waiting for a turn to end would miss some changes.

Opening another Mini App viewer previously obtained a fresh native snapshot. A shared cache removes that accidental freshness check. The cache therefore needs its own invalidation boundary.

Reconnecting the Telegram listener is the wrong boundary. That listener also owns prompt observations, receipt recovery, interactive questions, typing, and reply delivery. Refreshing a read-only presentation index must not replace those lifecycles or replay old Telegram messages.

## 2. Constraints and guarantee

- Use stock OMP. No upstream changes, fork, custom build, or patching native internals.
- Keep the managed session's persistent Collab connection. Do not open a native connection per managed-session browser viewer.
- Keep the browser transfer paginated. A refresh may still transfer a full native snapshot from OMP to the bot.
- OMP remains the history authority. Do not rebuild browser history directly from JSONL with a second implementation of native replication filtering and payload shrinking.
- Read the managed history path through the runtime's validated binding. Do not infer it from a working directory or scan for a matching filename.
- Preserve read authorization across asynchronous read steps. Recheck local listener identity, session generation, assignment, and closure after waits. Cache invalidation does not advance the authorization or session-kill generation.

The watcher detects persisted native history rewrites. It cannot prove that native memory has not changed before persistence completes, or after persistence fails. File timestamps are not a native in-memory revision. The implementation must not claim stronger consistency.

Stock attached-host registry metadata does not expose `sessionFile`. Watcher coverage therefore applies to managed sessions with a verified file path. Use a fresh native snapshot and a viewer-owned paginated index for attached viewer joins instead of reusing the shared historical cache. This fallback costs an additional connection and provides fresh joins, not rewrite detection for an already-open attached viewer. Do not invent a file path or advertise the managed-session freshness guarantee for attached hosts.

## 3. Watch the directory and check the current path

OMP normally appends to the existing file. Its full file rewrites stage a replacement beside the history file and rename that replacement over the current path. Watching only the file can leave the watcher attached to the old inode after the first replacement.

The runtime supplies a validated source identity containing the topic session, native session, host binding, and history path. A session-owned watcher observes the resolved history file's parent directory. It also checks the logical binding path so a changed path or symlink target cannot silently retain the previous source.

A directory event is a hint, not proof of a rewrite. The watcher stats the current path and compares it with an open file handle retained for the accepted cache baseline. Keeping that handle open prevents the old inode from being reused while the baseline is active.

Use the following classification under the stock native file-writer contract:

- A different device or inode, a smaller file, a changed binding, or a changed native identity makes the history dirty.
- Same-file growth follows the append path and does not trigger a full snapshot. Existing live `entry` frames continue updating the index.
- An unexplained same-size metadata change is conservatively dirty. An in-place title-slot update may cause an unnecessary refresh.
- A missing file or a stat failure is not an empty conversation. Mark the source unverified and retain the original diagnostic.
- Temporary staging-file activity does not invalidate the cache unless the current history path changes.

Re-stat before every viewer bootstrap and historical-page read. This catches missed notifications at the read boundary. While viewers are connected, add a low-frequency metadata check to catch a lost notification even when no page request occurs. Watcher errors retain their original diagnostics and use metadata checks while observation is restored. These checks validate file identity, not cache age.

The file checks do not cover arbitrary external in-place edits that imitate append behavior. The supported writer is stock OMP, not an unrelated process modifying earlier bytes.

## 4. Refresh over the existing stock connection

Stock OMP 18.16.0 accepts another authenticated `hello` on an established guest connection. It responds with another `welcome` and complete snapshot. This provides a refresh route without another socket or a bot-listener reconnect.

The repository's `openCollab` currently rejects a second welcome and a second snapshot. Add an internal, single-flight snapshot-refresh operation rather than allowing arbitrary browser-controlled native frames. Only an explicitly requested refresh may accept the additional handshake. Validate the session identity and snapshot count again.

The native host serializes a snapshot synchronously and queues its chunks in FIFO order before later live frames. Keeping the refresh on the same connection avoids merging independently ordered streams from a temporary reader and the existing bot listener.

Route refresh snapshot frames to a replacement history index, not through Telegram's initial snapshot-recovery path. In particular, do not reset prompt receipt boundaries or mirror those historical entries again. Continue processing ordinary native live and control frames once.

A repeated hello also replays pending native UI requests and emits a Collab join notice. Preserve the existing question deduplication by listener and request ID. Check questions awaiting answer acknowledgement as well as questions still on screen. Do not treat the refresh as a new participant or reset pending prompt, answer, or stop observations.

Only one native snapshot refresh may be outstanding. There is no snapshot request ID in the stock protocol. After timeout or cancellation, drain or fence the late snapshot before issuing another hello. Do not mistake the previous request's delayed welcome for a new refresh.

This route preserves the connection and bot lifecycle, not zero-delay delivery. A full snapshot occupies the native FIFO and can delay later live frames, especially for a large session. Coalescing rewrite notifications and ignoring ordinary append events avoids paying that cost per token, message, or viewer.

## 5. Cache publication and browser reset

Represent freshness as one session-owned state machine with clean, dirty, refreshing, and closed states. Keep one refresh promise per session. Multiple viewers and directory events share that operation.

1. Install observation and open the baseline file before requesting the initial snapshot or a replacement snapshot.
2. Mark the history dirty immediately when a rewrite is detected. Stop serving bootstrap and older pages from that index.
3. Build a candidate SQLite index from the requested native snapshot. Keep the accepted index separate until the candidate is complete.
4. Compare the current path with the source identity captured before the request. If another replacement occurred, do not certify the candidate against a baseline sampled afterward. Coalesce the change into another refresh.
5. Publish the candidate only after a complete, validated snapshot and a compatible source check. Rotate the history cursor epoch and retire the old index and baseline handle.
6. Apply subsequent live frames in the existing connection's order. Do not replay a second transport's backlog into the candidate.

A rewrite during a refresh must not be lost. Ordinary appends during the refresh must not cause an endless rebuild loop. A failed rebuild leaves the cache dirty and reports the original diagnostic without disposing the Telegram listener. Repeated publication failures must not create an unbounded refresh loop.

The browser needs a history-only invalidation and replacement path. Do not use a full socket reconnect or another browser `welcome` as the reset mechanism, because those reset stream and tool presentation state.

On invalidation, cancel pending page reads, disable older-page requests, and mark displayed history as refreshing. Already-rendered rows can remain until the replacement arrives. On publication, replace those rows atomically with the fresh recent page and new cursor epoch. Preserve current stream, tools, agents, authorization, and tail-following choice. A deeply scrolled reader may return to the recent page when the old history is replaced. Do not silently download all earlier pages to preserve that position.

Ignore late replies from the old epoch. A stale cursor caused by this transition must produce the history reset path, not the current gateway's fatal socket-close path. Continue rejecting malformed cursors independently.

Dispose the watcher, periodic checks, file handles, refresh work, and temporary index with their owning listener. Rebind after a validated worktree or history-path change. Fence asynchronous results after closure, detach, host replacement, or service shutdown.

## 6. Implementation order

The steps below describe one cutover. Intermediate commits must not expose a partially wired freshness guarantee.

1. **Validated source discovery.** Extend `src/runtime.ts` and its existing binding tests. Return a verified managed history source or an explicit attached-source limitation. Keep path validation at this boundary.
2. **Directory observation.** Add the session-owned watcher and focused filesystem integration tests. Cover replacement, repeated replacement, normal growth, missed notifications, missing files, and cleanup.
3. **Ordered native refresh.** Extend `src/collab.ts`, the internal connection contract, and `test/collab.test.ts`. Cover a requested second snapshot, unexpected duplicate handshakes, concurrent callers, and delayed completion after cancellation.
4. **Candidate index publication.** Extend `src/session-feed.ts` and `test/session-feed.test.ts`. Separate index replacement from retained live presentation state. Cover same-ID content replacement, removal, refresh races, and epoch rotation.
5. **Bot and gateway integration.** Wire source ownership and asynchronous freshness checks through `src/bot.ts` and `src/server.ts`. Preserve receipt and question ownership. Migrate callers to await read preparation rather than starting refresh work inside a synchronous send callback.
6. **Browser history replacement.** Extend the browser contracts, `web/src/lib/client.ts`, and the existing history scenarios. Add the refreshing presentation without resetting the client or loading the whole history. Verify the actual transcript component.
7. **Acceptance and current documentation.** Exercise the complete rewrite-to-browser path against stock OMP. Update `PRODUCT.md` and `ARCHITECTURE.md` only once the behavior exists. Remove this plan when those documents and implementation capture its decisions.

Use independent review for source-check races and ordered refresh before shipping. Avoid parallel edits across the shared connection, feed, and browser contracts until their interfaces are settled.

## 7. Verification

The implementation must prove the following behavior rather than assert UI wording:

- A warm managed join remains paginated and does not request a new native snapshot when the source is clean.
- A real persisted native rewrite with unchanged IDs changes the displayed protocol data for existing and new viewers. Removed entries do not reappear.
- Repeated atomic replacements remain observable. A suppressed watch notification is caught by a read-boundary or periodic identity check.
- A rewrite during refresh cannot publish a falsely clean index. Ordinary live appends cannot cause refresh starvation.
- Concurrent viewers share one refresh. Old page replies cannot repopulate the new history.
- Streaming, question answers, prompt receipts, and Telegram side effects remain correct across refresh. Historical replies are not sent again.
- Close, detach, worktree relocation, access revocation, watcher failure, and refresh failure cannot publish into a replacement session or leave owned resources running.
- Attached sessions use fresh native snapshots rather than an unverified shared cache. Their browser transfer remains paginated.

Run new isolated scenarios directly with `pnpm test:one` and concurrency five. Use real temporary files only for watcher and persistence behavior. Run the full isolated suite and live Telegram end-to-end suite on the final PR revision before merge. Use the existing `pnpm check`, `pnpm build`, and smoke scripts for their respective boundaries. Do not rerun passing tests for documentation-only changes, and do not deploy from this worktree.

## 8. Evidence used for this plan

- [Stock 18.16.0 host](https://raw.githubusercontent.com/can1357/oh-my-pi/v18.16.0/packages/coding-agent/src/collab/host.ts) dispatches `hello` without a first-hello-only guard, captures the snapshot synchronously, and replays pending UI requests.
- [Stock 18.16.0 transport](https://raw.githubusercontent.com/can1357/oh-my-pi/v18.16.0/packages/coding-agent/src/collab/relay-client.ts) queues snapshot batches and later sends in FIFO order.
- [Stock 18.16.0 file storage](https://raw.githubusercontent.com/can1357/oh-my-pi/v18.16.0/packages/coding-agent/src/session/session-storage.ts) stages full rewrites and publishes them by rename.
- [Stock 18.16.0 session manager](https://raw.githubusercontent.com/can1357/oh-my-pi/v18.16.0/packages/coding-agent/src/session/session-manager.ts) distinguishes append notification from `rewriteEntries()` persistence.
- [Stock 18.16.0 registry](https://raw.githubusercontent.com/can1357/oh-my-pi/v18.16.0/packages/coding-agent/src/collab/registry.ts) does not publish a session file path for attached hosts.
- An isolated runtime probe against the installed stock 18.16.0 executable received two welcomes and two completed snapshots on one WebSocket. The second welcome contained a title changed after the first snapshot. It sent no model prompt or Telegram request. This proves repeated hello support, not the proposed cache fix or its races.
- Earlier isolated native persistence probes observed that appends preserved the inode and a full rewrite replaced it. A same-length content rewrite preserved file size, entry count, and leaf identity while changing the inode and source digest.
