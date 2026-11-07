using System.Text.Json;
using System.Text.Json.Serialization;
using CounterStrikeSharp.API;
using CounterStrikeSharp.API.Core;
using CounterStrikeSharp.API.Modules.Events;
using CounterStrikeSharp.API.Modules.Timers;
using CounterStrikeSharp.API.Modules.Utils;
using Microsoft.Extensions.Logging;

namespace RanalanGate;

public class RanalanGateConfig : BasePluginConfig
{
    [JsonPropertyName("SiteUrl")]
    public string SiteUrl { get; set; } = "";

    [JsonPropertyName("Key")]
    public string Key { get; set; } = "";

    // The server's id in the site's servers.json.
    [JsonPropertyName("ServerId")]
    public string ServerId { get; set; } = "";

    [JsonPropertyName("RecheckSeconds")]
    public int RecheckSeconds { get; set; } = 30;
}

// Asks the site who may be on this server, and kicks everyone else. Admins can always
// join, and other players only while they have a match loaded here. If the site can't
// be reached nobody is kicked, so a site problem never throws out a running match.
public class RanalanGatePlugin : BasePlugin, IPluginConfig<RanalanGateConfig>
{
    public override string ModuleName => "RanalanGate";
    public override string ModuleVersion => "1.0.0";
    public override string ModuleDescription => "Lets only admins and the current match's players on the server";

    private static readonly HttpClient Http = new() { Timeout = TimeSpan.FromSeconds(5) };
    private const float FallRescueHeight = -3000f;

    public RanalanGateConfig Config { get; set; } = new();

    // Test matches: how many players and bots to keep on the server, and who has typed .ready.
    private int _testBotQuota;
    private DateTime _lastStartAttempt = DateTime.MinValue;
    private bool _teamsFull;
    private HashSet<ulong> _testPlayers = new();
    private readonly HashSet<ulong> _readyPlayers = new();

    public void OnConfigParsed(RanalanGateConfig config)
    {
        Config = config;
    }

    public override void Load(bool hotReload)
    {
        RegisterEventHandler<EventPlayerConnectFull>((@event, _) =>
        {
            var player = @event.Userid;
            if (player != null && IsHuman(player))
            {
                CheckPlayer(player.SteamID, player.UserId);
            }
            return HookResult.Continue;
        });

        // Also catches the end of a match, when players are no longer allowed.
        AddTimer(Math.Max(5, Config.RecheckSeconds), () =>
        {
            foreach (var player in Utilities.GetPlayers().Where(IsHuman))
            {
                CheckPlayer(player.SteamID, player.UserId);
            }
        }, TimerFlags.REPEAT);

        RegisterListener<Listeners.OnMapStart>(_ =>
        {
            _lastStartAttempt = DateTime.MinValue;
            _teamsFull = false;
            _readyPlayers.Clear();
        });

        RegisterEventHandler<EventPlayerChat>((@event, _) =>
        {
            TrackReady(@event.Userid, @event.Text);
            return HookResult.Continue;
        });

        RegisterEventHandler<EventRoundEnd>((_, _) =>
        {
            // A short wait lets the game finish counting the round.
            AddTimer(1.0f, SendBotStats);
            return HookResult.Continue;
        });

        AddTimer(1, RescueFallingPlayers, TimerFlags.REPEAT);

        // Keeps the bots right for whatever the site says is loaded here.
        AddTimer(5, RefreshTestMatch, TimerFlags.REPEAT);
    }

    private void RefreshTestMatch()
    {
        var url = $"{Config.SiteUrl}/matchzy/server?server={Uri.EscapeDataString(Config.ServerId)}";
        var key = Config.Key;

        Task.Run(async () =>
        {
            int quota;
            HashSet<ulong> testPlayers;
            bool botsOnly;
            try
            {
                using var body = JsonDocument.Parse(await GetFromSite(url, key));
                quota = body.RootElement.GetProperty("testBotQuota").GetInt32();
                testPlayers = body.RootElement.GetProperty("testPlayers").EnumerateArray()
                    .Select(id => ulong.Parse(id.GetString() ?? "0"))
                    .ToHashSet();
                botsOnly = body.RootElement.GetProperty("botsOnly").GetBoolean();
            }
            catch (Exception ex)
            {
                Logger.LogWarning("Could not ask the site about test matches: {Message}", ex.Message);
                return;
            }
            Server.NextFrame(() =>
            {
                ApplyBotQuota(quota, testPlayers);
                StartBotsOnlyMatch(botsOnly);
            });
        });
    }

    // MatchZy leaves bots out of its stats, so they're sent to the site from here.
    private void SendBotStats()
    {
        if (_testBotQuota == 0)
        {
            return;
        }

        var players = Utilities.GetPlayers().Where(p => p.IsValid && !p.IsHLTV).ToList();
        var team1Side = players.FirstOrDefault(p => !p.IsBot && _testPlayers.Contains(p.SteamID))?.Team ?? CsTeam.None;
        var rounds = Utilities.FindAllEntitiesByDesignerName<CCSGameRulesProxy>("cs_gamerules")
            .FirstOrDefault()?.GameRules?.TotalRoundsPlayed ?? 0;

        var bots = players.Where(p => p.IsBot).Select(bot =>
        {
            var stats = bot.ActionTrackingServices?.MatchStats;
            return new
            {
                name = bot.PlayerName,
                // 0 asks the site to work it out from the side, when there's no human to compare.
                team = team1Side == CsTeam.None ? 0 : (bot.Team == team1Side ? 1 : 2),
                side = bot.Team == CsTeam.Terrorist ? "t" : "ct",
                kills = stats?.Kills ?? 0,
                deaths = stats?.Deaths ?? 0,
                assists = stats?.Assists ?? 0,
                headshots = stats?.HeadShotKills ?? 0,
                damage = stats?.Damage ?? 0,
                rounds,
            };
        }).ToList();

        var url = $"{Config.SiteUrl}/matchzy/bot-stats";
        var key = Config.Key;
        var body = JsonSerializer.Serialize(new { server = Config.ServerId, bots });

        Task.Run(async () =>
        {
            try
            {
                using var request = new HttpRequestMessage(HttpMethod.Post, url)
                {
                    Content = new StringContent(body, System.Text.Encoding.UTF8, "application/json"),
                };
                request.Headers.Add("X-Ranalan-Key", key);
                using var response = await Http.SendAsync(request);
                response.EnsureSuccessStatusCode();
            }
            catch (Exception ex)
            {
                Logger.LogWarning("Could not send bot stats: {Message}", ex.Message);
            }
        });
    }

    // A player moved between teams can spawn at the map's centre point, outside the level,
    // and fall forever. No map's playable area goes this low, so anyone down here gets
    // moved to one of their team's spawn points.
    private void RescueFallingPlayers()
    {
        foreach (var player in Utilities.GetPlayers().Where(IsHuman))
        {
            var pawn = player.PlayerPawn?.Value;
            if (pawn == null || !pawn.IsValid || pawn.LifeState != (byte)LifeState_t.LIFE_ALIVE
                || pawn.AbsOrigin == null || pawn.AbsOrigin.Z >= FallRescueHeight)
            {
                continue;
            }

            // A real respawn restores the body and weapons, which moving alone wouldn't.
            Logger.LogInformation("Respawning {SteamId}: fell out of the map.", player.SteamID);
            player.Respawn();

            var steamId = player.SteamID;
            AddTimer(0.2f, () => MoveToSpawnIfOutside(steamId));
        }
    }

    private void MoveToSpawnIfOutside(ulong steamId)
    {
        var player = Utilities.GetPlayers().FirstOrDefault(p => IsHuman(p) && p.SteamID == steamId);
        var pawn = player?.PlayerPawn?.Value;
        if (player == null || pawn == null || !pawn.IsValid || pawn.AbsOrigin == null)
        {
            return;
        }

        // The middle of the map is where a failed spawn puts people.
        var outside = pawn.AbsOrigin.Z < FallRescueHeight || (pawn.AbsOrigin.X == 0 && pawn.AbsOrigin.Y == 0);
        var spawn = outside ? FindSpawnPoint(player.Team) : null;
        if (spawn != null)
        {
            Logger.LogInformation("Moving {SteamId} to a spawn point.", steamId);
            pawn.Teleport(spawn.AbsOrigin, spawn.AbsRotation, new Vector(0, 0, 0));
        }
    }

    private static SpawnPoint? FindSpawnPoint(CsTeam team)
    {
        var className = team == CsTeam.Terrorist ? "info_player_terrorist" : "info_player_counterterrorist";
        var spawns = Utilities.FindAllEntitiesByDesignerName<SpawnPoint>(className)
            .Where(s => s.IsValid && s.AbsOrigin != null)
            .ToList();

        // Wingman switches off the spawn points of the unused bombsite.
        var usable = spawns.Where(s => s.Enabled).ToList();
        var choices = usable.Count > 0 ? usable : spawns;
        return choices.Count > 0 ? choices[Random.Shared.Next(choices.Count)] : null;
    }

    // A start can come too early, while MatchZy is still loading the match, and then does
    // nothing. So if it's still warmup after a while, it's safe to try again.
    private bool StartAttemptAllowed()
    {
        return (DateTime.UtcNow - _lastStartAttempt).TotalSeconds >= 20;
    }

    // Nobody can type .ready in a bots-only match, so it starts as soon as the sides are full.
    private void StartBotsOnlyMatch(bool botsOnly)
    {
        if (botsOnly && _teamsFull && StartAttemptAllowed() && IsWarmup())
        {
            _lastStartAttempt = DateTime.UtcNow;
            Logger.LogInformation("Bots-only test match: starting.");
            Server.ExecuteCommand("css_start");
        }
    }

    private void ApplyBotQuota(int quota, HashSet<ulong> testPlayers)
    {
        _testPlayers = testPlayers;
        if (quota > 0)
        {
            var waiting = Utilities.GetPlayers()
                .Where(p => IsHuman(p)
                    && (p.Team == CsTeam.Spectator || p.Team == CsTeam.None)
                    && testPlayers.Contains(p.SteamID))
                .ToList();
            waiting.ForEach(PickTeamFor);

            // Bots are only balanced once everyone is on their team, so they fill the right side.
            _teamsFull = waiting.Count == 0 && BalanceBots(quota / 2);
        }
        else
        {
            // MatchZy's live configs no longer remove bots, so this keeps real matches free of them.
            Server.ExecuteCommand(_testBotQuota > 0 ? "bot_quota 0; bot_kick" : "bot_quota 0");
            _teamsFull = false;
        }
        _testBotQuota = quota;
        StartIfEveryoneReady();
    }

    // Tops up each side to the team size, so every human on a side replaces one bot there.
    // Returns true if both sides were already full.
    private static bool BalanceBots(int perSide)
    {
        // bot_join_after_player 0 lets bots join and play on a server with no humans.
        Server.ExecuteCommand("bot_quota_mode normal; bot_join_after_player 0; mp_autoteambalance 0; mp_limitteams 0");
        var balanced = true;

        foreach (var (side, addCommand) in new[] { (CsTeam.CounterTerrorist, "bot_add_ct"), (CsTeam.Terrorist, "bot_add_t") })
        {
            var players = Utilities.GetPlayers().Where(p => p.IsValid && !p.IsHLTV && p.Team == side).ToList();
            var extra = players.Count - perSide;
            balanced &= extra == 0;

            foreach (var bot in players.Where(p => p.IsBot).Take(Math.Max(0, extra)))
            {
                Server.ExecuteCommand($"bot_kick \"{bot.PlayerName}\"");
            }
            for (var missing = -extra; missing > 0; missing--)
            {
                Server.ExecuteCommand(addCommand);
            }
        }
        return balanced;
    }

    private void TrackReady(int userId, string? text)
    {
        var message = (text ?? "").Trim().ToLowerInvariant();
        var player = Utilities.GetPlayerFromUserid(userId);
        if (player == null || !IsHuman(player))
        {
            return;
        }

        if (message is ".ready" or ".r" or "!ready" or "!r")
        {
            _readyPlayers.Add(player.SteamID);
            StartIfEveryoneReady();
        }
        else if (message is ".unready" or ".ur" or "!unready" or "!ur")
        {
            _readyPlayers.Remove(player.SteamID);
        }
    }

    // Bots can't type .ready, so in a test match the humans being ready is enough.
    private void StartIfEveryoneReady()
    {
        // Waiting for full teams means round 1 can't end early because a side is empty.
        if (_testBotQuota == 0 || !_teamsFull || !StartAttemptAllowed() || !IsWarmup())
        {
            return;
        }

        var players = Utilities.GetPlayers()
            .Where(p => IsHuman(p) && (p.Team == CsTeam.CounterTerrorist || p.Team == CsTeam.Terrorist))
            .ToList();
        if (players.Count > 0 && players.All(p => _readyPlayers.Contains(p.SteamID)))
        {
            _lastStartAttempt = DateTime.UtcNow;
            Logger.LogInformation("Test match: everyone is ready, starting.");
            Server.ExecuteCommand("css_start");
        }
    }

    private static bool IsWarmup()
    {
        var proxy = Utilities.FindAllEntitiesByDesignerName<CCSGameRulesProxy>("cs_gamerules").FirstOrDefault();
        return proxy?.GameRules?.WarmupPeriod ?? false;
    }

    private static async Task<string> GetFromSite(string url, string key)
    {
        using var request = new HttpRequestMessage(HttpMethod.Get, url);
        request.Headers.Add("X-Ranalan-Key", key);
        using var response = await Http.SendAsync(request);
        response.EnsureSuccessStatusCode();
        return await response.Content.ReadAsStringAsync();
    }

    private static bool IsHuman(CCSPlayerController player)
    {
        return player.IsValid && !player.IsBot && !player.IsHLTV;
    }

    private void CheckPlayer(ulong steamId, int? userId)
    {
        if (userId == null || steamId == 0)
        {
            return;
        }

        var url = Config.SiteUrl;
        var key = Config.Key;
        var serverId = Config.ServerId;

        Task.Run(async () =>
        {
            bool allowed;
            bool matchLoaded;
            try
            {
                using var body = JsonDocument.Parse(await GetFromSite(
                    $"{url}/matchzy/access?server={Uri.EscapeDataString(serverId)}&steam={steamId}", key));
                allowed = body.RootElement.GetProperty("allowed").GetBoolean();
                matchLoaded = body.RootElement.GetProperty("matchLoaded").GetBoolean();
            }
            catch (Exception ex)
            {
                Logger.LogWarning("Could not ask the site about {SteamId}: {Message}", steamId, ex.Message);
                return;
            }

            if (!allowed)
            {
                Server.NextFrame(() => Kick(steamId, userId.Value));
            }
            else if (matchLoaded)
            {
                // Right after connecting it can be too early, so try again a few times.
                Server.NextFrame(() =>
                {
                    JoinTeam(steamId, userId.Value);
                    foreach (var delay in new[] { 1f, 3f, 6f })
                    {
                        AddTimer(delay, () => JoinTeam(steamId, userId.Value));
                    }
                });
            }
        });
    }

    private void JoinTeam(ulong steamId, int userId)
    {
        var player = Utilities.GetPlayers().FirstOrDefault(p => p.UserId == userId && p.SteamID == steamId);
        if (player != null && IsHuman(player) && player.Team == CsTeam.None)
        {
            PickTeamFor(player);
        }
    }

    // Does what picking in the team menu does, so the game spawns the player properly.
    // MatchZy blocks every choice except the player's own team, so one of these goes
    // through: CT, T, or spectators for admins who aren't playing.
    private static void PickTeamFor(CCSPlayerController player)
    {
        player.ExecuteClientCommandFromServer("jointeam 3");
        player.ExecuteClientCommandFromServer("jointeam 2");
        player.ExecuteClientCommandFromServer("jointeam 1");
    }

    private void Kick(ulong steamId, int userId)
    {
        // The slot may belong to someone else by now, so match on the SteamID too.
        var player = Utilities.GetPlayers().FirstOrDefault(p => p.UserId == userId && p.SteamID == steamId);
        if (player != null && IsHuman(player))
        {
            Logger.LogInformation("Kicking {SteamId}: not an admin or a player in a match here.", steamId);
            Server.ExecuteCommand($"kickid {userId}");
        }
    }
}
