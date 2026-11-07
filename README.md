# Ranalan

CS2 LAN and league site: Steam login, teams with invite links, a click-based map vote that sends the match to a MatchZy server, live scores and stats, test matches with bots, GOTV for admins, and servers that turn on and off by themselves.

**Setting up for a new LAN:** follow [docs/NEXT-LAN.md](docs/NEXT-LAN.md).

## Run it locally

Needs Node 24 or newer, and no packages to install. Copy the example settings first:

```bash
cp .env.dev.example .env.dev && cp servers.dev.example.json servers.dev.json
```

```bash
node --env-file-if-exists=.env.dev src/server.js
```

Open http://localhost:3000. `.env.dev` turns on a test login that only works from this machine:

```
/dev-login?steam=76561198000000001&name=Test&admin=1
```

Run the tests with `npm test`.

## How a match reaches the server

1. An admin creates a match, and the captains click bans, picks and sides.
2. The site sends `matchzy_loadmatch_url` to the server over RCON.
3. MatchZy downloads the config from `/matchzy/<id>/<token>.json`, so the game server must be able to reach the site.
4. Players connect and type `.ready` on each map. MatchZy kicks anyone not on the rosters, and admins not playing are listed as spectators.
5. MatchZy posts its events to `/matchzy/events`, with a shared key in the `X-Ranalan-Key` header. The site saves scores and player stats from them and finishes the match on `series_end`. MatchZy doesn't resend events the site misses.

The `plugin/RanalanGate` CounterStrikeSharp plugin keeps the server closed. It asks `/matchzy/access` about each player on joining and every 30 seconds, and kicks anyone who isn't an admin or a player in a match loaded on that server. If the site can't be reached, nobody is kicked. A built copy is in `deploy/RanalanGate.dll`.

## Server power

With `PANEL_URL`, `PANEL_API_KEY` and a `panelId` on the server (the first part of its UUID), the site uses Pterodactyl's client API to start a server when a match is created and to stop it about 5 minutes after nothing needs it. Admins can also start and stop servers on the Admin page, and a manual start holds the server on for at least an hour. Without these settings, servers are left alone.

## Deploy

Run `bash deploy/install.sh` as root on the game server machine. It writes `.env` and `servers.json`, sets RCON, GOTV and MatchZy settings on each server, installs the RanalanGate plugin, moves the old vote plugin aside and builds and starts the site with plain `docker`. It's safe to run again for updates. The full steps are in [docs/NEXT-LAN.md](docs/NEXT-LAN.md).

`servers.json` holds RCON passwords and is never committed. Each entry has `id`, `name`, `host`, `port`, `mode` (`wingman` or `5v5`), `rconPassword`, and optionally `rconHost`, `rconPort` and `playersPerTeam`.
