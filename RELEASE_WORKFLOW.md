# Wintermaul releases

`release.json` is the source for the public game release and multiplayer protocol. Keep the release version and protocol identity separate: raise `releaseVersion` for each release, and change `multiplayer.protocolId` only when the multiplayer message format or game-state meaning becomes incompatible.

The protocol accepts new clients with the exact protocol ID. It accepts older clients only when their release is listed in `compatibleLegacyReleaseVersions`. Keep that list in ascending order and remove a release when it can no longer exchange valid game state. The server keeps strict game-state validation after the handshake.

Public versions now use `1.10`, `1.11`, … `1.99`, then `2.0`. The package command derives npm-compatible package versions (`1.10.0`) from the same release value; browser titles, cache keys, diagnostics, and ZIP names use `1.10`.

The 1.10 balance pass changes upgrade costs and combat rules, so it starts protocol `wintermaul-mp/2`. Older balance rules cannot safely share purchases and host migration with this release. Future releases using these same compatible rules keep `/2` even when their release number changes.

The 1.11 Naga compendium unlock is stored in each player's browser. It adds no Naga tower definitions or new multiplayer state, so it remains compatible with protocol `/2`.

Release 1.12 splits the top-center spawn across left and right routes and spaces groups farther apart. The host already transmits each enemy's path, so this requires no multiplayer protocol change.

Release 1.13 improves synchronized spawn spacing, clears attacks when waves finish, adds locally synthesized tower and enemy effects, and catches up host simulation when a background tab throttles rendering. Its multiplayer state remains compatible with 1.12 and continues using protocol `/2`.

Release 1.14 makes browsers revalidate game files on visits. The Node host responds with ETags and Last-Modified validators, and the webhost `.htaccess` sets cache revalidation for site files. This cache-only change keeps multiplayer on protocol `/2` and accepts releases 1.12 and 1.13.

Release 1.15 removes redundant headings from the statistics and Compendium menus and centers the variant artwork. It does not change multiplayer state and remains compatible with releases 1.12 through 1.14 on protocol `/2`.

Release 1.16 lowers menu and game music output and raises the procedural tower/enemy sound level while preserving the full SFX slider range. It does not change multiplayer state and remains compatible with releases 1.12 through 1.15 on protocol `/2`.

Release 1.17 removes enemy-to-enemy separation so overlapping units cannot block or stall one another, and adds a top-left in-game Menu button that opens the existing Escape options panel. It does not change multiplayer state and remains compatible with releases 1.12 through 1.16 on protocol `/2`.

Release 1.18 scales multiplayer enemy health by 50% per additional connected player, adds the `GREEDISGOOD` 9999-gold cheat for single-player matches, reduces projectile artwork size, and makes a small shared music/SFX level adjustment. The multiplayer health change uses the existing authoritative snapshot fields, so protocol `/2` remains compatible with releases 1.12 through 1.17.

Release 1.19 selects Orc, Undead, and Night Elf game music according to each player's lobby race. Human and races without a dedicated track use the default game music. Race-specific tracks retain the existing shared music volume, fallback, and replay behavior, so no multiplayer protocol change is needed.

## Build and check

From the complete Wintermaul source folder:

```sh
npm run release:check
npm run release:package -- --webroot /path/to/current/webroot --source-index /path/to/current/index.html
```

The package step reads the webhost snapshot as its asset source, takes the current `index.html` from `--source-index` (or the project root when omitted) and the multiplayer client from the project, generates the visible title version and `assets/js/release-config.js`, updates client cache keys from `release.json`, then writes `release-output/Wintermaul-webhost-v<version>.zip`. The archive contains only files whose hashes differ from `.release/webhost-baseline.json`, with webroot paths preserved. It leaves analytics PHP and analytics data out of the game upload.

Upload the backend commit to Render first so current and explicitly compatible older browser clients can connect during rollout. Then upload the ZIP contents to the webhost, preserving paths. After confirming the upload, record the new baseline with:

```sh
npm run release:mark-uploaded -- --webroot /path/to/current/webroot
```

Do not change the protocol ID for a compatible game release. A breaking network change gets a new protocol ID; clients with a different ID are rejected and receive both release and protocol diagnostics.

Release 1.20 highlights each occupied lobby slot with the color palette for that player's selected race. It changes only lobby presentation and remains compatible with releases 1.12 through 1.19 on protocol `/2`.
