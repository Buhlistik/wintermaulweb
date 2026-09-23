# Wintermaul releases

`release.json` is the source for the public game release and multiplayer protocol. Keep the release version and protocol identity separate: raise `releaseVersion` for each release, and change `multiplayer.protocolId` only when the multiplayer message format or game-state meaning becomes incompatible.

The protocol accepts new clients with the exact protocol ID. It accepts older clients only when their release is listed in `compatibleLegacyReleaseVersions`. Keep that list in ascending order and remove a release when it can no longer exchange valid game state. The server keeps strict game-state validation after the handshake.

## Build and check

From the complete Wintermaul source folder:

```sh
npm test
npm run release:check
npm run release:package -- --webroot /path/to/current/webroot --source-index /path/to/current/index.html
```

The package step reads the webhost snapshot as its asset source, takes the current `index.html` from `--source-index` (or the project root when omitted) and the multiplayer client from the project, generates the visible title version and `assets/js/release-config.js`, updates client cache keys from `release.json`, then writes `release-output/Wintermaul-webhost-v<version>.zip`. The archive contains only files whose hashes differ from `.release/webhost-baseline.json`, with webroot paths preserved. It leaves analytics PHP and analytics data out of the game upload.

Upload the backend commit to Render first so current and explicitly compatible older browser clients can connect during rollout. Then upload the ZIP contents to the webhost, preserving paths. After confirming the upload, record the new baseline with:

```sh
npm run release:mark-uploaded -- --webroot /path/to/current/webroot
```

Do not change the protocol ID for a compatible game release. A breaking network change gets a new protocol ID; clients with a different ID are rejected and receive both release and protocol diagnostics.
