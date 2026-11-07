# Setting up Ranalan for the next LAN

Everything used for CS2 Ranalan Q4 2026 (November 2026): the site, the server plugin and the installer.
Follow this from top to bottom on a new machine, or skip steps that are already done.

## 1. Game servers in Pterodactyl

Per CS2 server (two wingman servers last time):

- **Egg and plugins:** the Kitsune CS2 egg with Metamod, CounterStrikeSharp (API 379 last time) and MatchZy 0.9.2.
- **Two ports:** give each server a game port and a GOTV port, both UDP. Last time it was 25567/25568 for Wingman 1 and 25569/25570 for Wingman 2.
- **GOTV port in startup:** add `+tv_port <GOTV port>` to the startup command in the panel. Setting `tv_port` in `server.cfg` is not enough, because GOTV then binds 27020.
- **Game server token:** set a Steam game server login token (GSLT) as usual.
- **Panel API key:** to let the site turn servers on and off, make a client API key in the panel (Account, API Credentials). The installer asks for it once and stores it only in `.env` on the machine.

Start each server once, so its files exist on disk.

## 2. Point the installer at the servers

Open `deploy/install.sh` and change the `SERVERS` list: one line per server with the id, name,
full Pterodactyl UUID (in the server's URL or Settings page), game port and GOTV port.

The machine's address, the site port and the admin's Steam ID can be changed at the top of the file,
or given when running it:

```bash
HOST_IP=10.0.0.5 ADMIN_ID=7656119xxxxxxxxxx bash /opt/ranalan/deploy/install.sh
```

For more than one admin, give `ADMIN_ID` several Steam IDs separated by commas. Don't edit `ADMIN_STEAM_IDS` in `.env` by hand, because the installer rewrites that file each time it runs.

## 3. Package, copy and install

On your own PC, from this folder:

```bash
mkdir -p dist && tar -czf dist/ranalan.tar.gz package.json Dockerfile README.md src public deploy
```

Copy `dist/ranalan.tar.gz` to `/tmp` on the game server machine (for example with `scp`), then as root:

```bash
mkdir -p /opt/ranalan && tar -xzf /tmp/ranalan.tar.gz -C /opt/ranalan && bash /opt/ranalan/deploy/install.sh
```

The installer needs Docker. It is safe to run again for updates, and keeps passwords and keys from earlier runs.
At the end it prints checks; each should match the "should be" value. Then restart the game servers in the panel.

What it sets on each server:

- RCON password, `sv_hibernate_when_empty 0`, GOTV with a password, `sv_deltaticks_enforce 0` (fixes "Client delta ticks out of order" for GOTV viewers).
- GOTV delay of 90 seconds, and the map change waits for GOTV to catch up (`tv_delaymapchange 1`). Both go in `gamemode_competitive2v2_server.cfg`, because the wingman mode config loads after `server.cfg` and sets its own delay of 60.
- MatchZy sends events to the site, and `matchzy_minimum_ready_required 64` so nobody starts a match on an empty server by accident.
- The RanalanGate plugin, which keeps the server closed to everyone but admins and the players in the loaded match.
- Old files are kept next to the originals with `.bak-ranalan` at the end.

The site runs at `http://<HOST_IP>:<SITE_PORT>` (port 8088 last time).

## 4. Test before the LAN

1. Sign in with Steam on the site. The admin's Steam ID sees the Admin page.
2. **Test match:** on Admin, make a test match. One player on each side is enough, and bots fill the rest. Play it through the vote, connect, `.ready` and a few rounds, and check the score and stats on the match page.
3. **Bots-only match:** a match with only bots, to check GOTV and the auto-director without players.
4. **GOTV:** the match page shows admins a copy box with the GOTV command (password included, so keep it off stream). Steam links don't work for GOTV ports, so paste it in the game console.
5. Start and stop a server from Admin, to check the panel connection.

## 5. On the day

- Teams register on the site and invite players with their invite links.
- For each match, create it on Admin as Best av 1 or Best av 3. Captains click bans, picks and sides, and the site loads it on the server.
- Players join and type `.ready`. Anyone not in the match is kicked automatically.
- Scores, stats and the winner are saved on the site by themselves.
- Demos are recorded by MatchZy while GOTV is on. Find them with:

  ```bash
  find /var/lib/pterodactyl/volumes/*/game/csgo -name "*.dem" | sort
  ```

## Rebuilding the plugin

Only needed after changing `plugin/RanalanGate/RanalanGate.cs`. Needs the .NET 8 SDK:

```bash
dotnet build plugin/RanalanGate -c Release
```

Copy `plugin/RanalanGate/bin/Release/net8.0/RanalanGate.dll` to `deploy/RanalanGate.dll`, and update the
checksum the installer expects at the bottom of `deploy/install.sh` (first 8 characters of its SHA-256).

## Things learned last time

- If a port is changed in the panel, restart every server that used it. A server holding the old port blocks the new one.
- `kill` doesn't work for players on these servers; it is cheat-protected.
- Changing teams with the server's ChangeTeam call broke spawns. RanalanGate uses `jointeam` instead.
- Don't use `mp_restartgame` during a MatchZy match. It breaks MatchZy's score.
- Map images in `public/maps` are in-game images from MurkyYT/cs2-map-icons (Valve's property).
- `WarmupMapVote/` is the old in-game vote plugin from before the site. The installer moves it aside on the servers, and it is kept here only for reference.
