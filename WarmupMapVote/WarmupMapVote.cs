using System.Text.Json;
using System.Text.Json.Serialization;
using CounterStrikeSharp.API;
using CounterStrikeSharp.API.Core;
using CounterStrikeSharp.API.Modules.Cvars;
using CounterStrikeSharp.API.Modules.Timers;
using CounterStrikeSharp.API.Modules.Utils;
using Microsoft.Extensions.Logging;

namespace WarmupMapVote;

public class WarmupMapVoteConfig : BasePluginConfig
{
    // "bo1" or "bo3". The tournament host sets this.
    [JsonPropertyName("Format")]
    public string Format { get; set; } = "bo1";

    // Used when the server runs game_mode 2.
    [JsonPropertyName("WingmanMaps")]
    public List<string> WingmanMaps { get; set; } = new()
    {
        "de_inferno", "de_nuke", "de_overpass", "de_vertigo", "de_poseidon", "de_debris", "de_eldorado"
    };

    // Used for any other game_mode, such as 5v5 competitive (game_mode 1).
    [JsonPropertyName("FiveVFiveMaps")]
    public List<string> FiveVFiveMaps { get; set; } = new()
    {
        "de_ancient", "de_anubis", "de_cache", "de_dust2", "de_inferno", "de_mirage", "de_nuke"
    };

    // Players each team needs. 0 means automatic: 2 for wingman, 5 otherwise.
    [JsonPropertyName("PlayersPerTeam")]
    public int PlayersPerTeam { get; set; } = 0;

    // Seconds the teams must stay unchanged before they are locked in.
    [JsonPropertyName("TeamLockDelaySeconds")]
    public int TeamLockDelaySeconds { get; set; } = 10;

    // How long the server must stay empty before an unfinished match is dropped.
    [JsonPropertyName("EmptyResetSeconds")]
    public int EmptyResetSeconds { get; set; } = 120;

    // Wait after a series ends so MatchZy has finished resetting.
    [JsonPropertyName("SeriesEndDelaySeconds")]
    public int SeriesEndDelaySeconds { get; set; } = 45;
}

// Sets up the match so MatchZy runs the ready-up, the map veto, side choice and
// series itself. This plugin only builds the match config from the current teams.
public class WarmupMapVotePlugin : BasePlugin, IPluginConfig<WarmupMapVoteConfig>
{
    public override string ModuleName => "WarmupMapVote";
    public override string ModuleVersion => "2.0.0";
    public override string ModuleDescription => "Starts a MatchZy map veto match from the players on the teams";

    private const string Prefix = " \x04[Map Vote]\x01 ";
    private const string MatchFile = "cfg/WarmupMapVote_match.json";

    public WarmupMapVoteConfig Config { get; set; } = new();

    private bool _matchLoaded;
    private int _lockCountdown = -1;
    private string _lockedTeams = "";
    private int _emptySeconds;
    private int _mapsToWin;
    private int _mapsToPlay;
    private int _mapsPlayed;
    private int _team1Wins;
    private int _team2Wins;
    private DateTime? _seriesEndedAt;
    private readonly HashSet<ulong> _team1Ids = new();

    public void OnConfigParsed(WarmupMapVoteConfig config)
    {
        Config = config;
    }

    public override void Load(bool hotReload)
    {
        RegisterListener<Listeners.OnMapStart>(_ =>
        {
            _emptySeconds = 0;
            _lockCountdown = -1;
            StartTicking();
        });

        RegisterEventHandler<EventCsWinPanelMatch>((_, _) =>
        {
            OnMapFinished();
            return HookResult.Continue;
        });

        if (hotReload)
        {
            StartTicking();
        }
    }

    private void StartTicking()
    {
        AddTimer(1.0f, Tick, TimerFlags.REPEAT | TimerFlags.STOP_ON_MAPCHANGE);
    }

    private void Tick()
    {
        var humans = GetHumans();

        if (humans.Count == 0)
        {
            _lockCountdown = -1;
            _emptySeconds++;
            if (_emptySeconds >= Config.EmptyResetSeconds && _matchLoaded)
            {
                // Nobody came back, so free the server for the next group.
                Logger.LogInformation("Server empty, dropping the unfinished match.");
                Server.ExecuteCommand("css_restart");
                ClearMatch();
            }
            return;
        }
        _emptySeconds = 0;

        if (_matchLoaded)
        {
            if (_seriesEndedAt.HasValue
                && (DateTime.UtcNow - _seriesEndedAt.Value).TotalSeconds >= Config.SeriesEndDelaySeconds)
            {
                ClearMatch();
            }
            return;
        }

        if (!IsWarmup())
        {
            _lockCountdown = -1;
            return;
        }

        TickTeamLock(humans);
    }

    private void TickTeamLock(List<CCSPlayerController> humans)
    {
        var needed = PlayersNeeded();
        var ct = humans.Where(p => p.Team == CsTeam.CounterTerrorist).ToList();
        var t = humans.Where(p => p.Team == CsTeam.Terrorist).ToList();

        if (ct.Count != needed || t.Count != needed)
        {
            _lockCountdown = -1;
            return;
        }

        // Any team change restarts the countdown, since teams lock afterwards.
        var teams = string.Join(",", ct.Select(p => p.SteamID).OrderBy(i => i)) + "|"
            + string.Join(",", t.Select(p => p.SteamID).OrderBy(i => i));

        if (_lockCountdown < 0 || teams != _lockedTeams)
        {
            _lockedTeams = teams;
            _lockCountdown = Config.TeamLockDelaySeconds;
            Server.PrintToChatAll(Prefix + $"Teams lock in {_lockCountdown} seconds. Switch now if you need to.");
            return;
        }

        _lockCountdown--;
        if (_lockCountdown <= 0)
        {
            _lockCountdown = -1;
            LoadMatch(ct, t);
        }
    }

    private void LoadMatch(List<CCSPlayerController> ct, List<CCSPlayerController> t)
    {
        var isWingman = IsWingman();
        var isBo3 = Config.Format.Trim().Equals("bo3", StringComparison.OrdinalIgnoreCase);
        var numMaps = isBo3 ? 3 : 1;
        var configured = isWingman ? Config.WingmanMaps : Config.FiveVFiveMaps;
        var maps = configured.Where(Server.IsMapValid).Distinct().ToList();

        // A bo3 needs two picks, two closing bans and a decider.
        var minimumMaps = isBo3 ? 5 : 2;
        if (maps.Count < minimumMaps)
        {
            Logger.LogWarning("No match loaded: {Valid} valid maps, {Needed} needed for {Format}.",
                maps.Count, minimumMaps, Config.Format);
            Server.PrintToChatAll(Prefix + "Not enough maps for the map vote. Tell the host.");
            _matchLoaded = true;
            _seriesEndedAt = DateTime.UtcNow;
            return;
        }

        var match = new Dictionary<string, object>
        {
            ["num_maps"] = numMaps,
            ["maplist"] = maps,
            ["skip_veto"] = false,
            ["veto_mode"] = BuildVetoOrder(maps.Count, isBo3),
            ["side_type"] = "standard",
            ["clinch_series"] = true,
            ["wingman"] = isWingman,
            ["players_per_team"] = ct.Count,
            ["min_players_to_ready"] = ct.Count,
            ["team1"] = BuildTeam(ct),
            ["team2"] = BuildTeam(t)
        };

        File.WriteAllText(Path.Join(Server.GameDirectory, "csgo", MatchFile), JsonSerializer.Serialize(match));

        _team1Ids.Clear();
        foreach (var player in ct)
        {
            _team1Ids.Add(player.SteamID);
        }

        _matchLoaded = true;
        _seriesEndedAt = null;
        _mapsPlayed = 0;
        _team1Wins = 0;
        _team2Wins = 0;
        _mapsToPlay = numMaps;
        _mapsToWin = numMaps / 2 + 1;

        Server.ExecuteCommand($"matchzy_loadmatch {MatchFile}");
        Server.PrintToChatAll(Prefix + $"Teams locked ({(isBo3 ? "BO3" : "BO1")}). Everyone type {ChatColors.Green}.ready{ChatColors.Default} to start the map vote.");
    }

    // Terrorists go first, then the teams alternate. team2 is the T side at lock time.
    private static List<string> BuildVetoOrder(int mapCount, bool isBo3)
    {
        var actions = new List<string>();
        if (isBo3)
        {
            actions.AddRange(Enumerable.Repeat("ban", mapCount - 5));
            actions.Add("pick");
            actions.Add("pick");
            actions.Add("ban");
            actions.Add("ban");
        }
        else
        {
            actions.AddRange(Enumerable.Repeat("ban", mapCount - 1));
        }

        return actions.Select((action, i) => (i % 2 == 0 ? "team2_" : "team1_") + action).ToList();
    }

    private static Dictionary<string, object> BuildTeam(List<CCSPlayerController> players)
    {
        return new Dictionary<string, object>
        {
            ["name"] = "Team " + players[0].PlayerName,
            ["players"] = players.ToDictionary(p => p.SteamID.ToString(), p => p.PlayerName)
        };
    }

    private void OnMapFinished()
    {
        if (!_matchLoaded || _seriesEndedAt.HasValue)
        {
            return;
        }

        _mapsPlayed++;

        var teams = Utilities.FindAllEntitiesByDesignerName<CCSTeam>("cs_team_manager").ToList();
        var ctScore = teams.FirstOrDefault(x => x.TeamNum == (byte)CsTeam.CounterTerrorist)?.Score ?? 0;
        var tScore = teams.FirstOrDefault(x => x.TeamNum == (byte)CsTeam.Terrorist)?.Score ?? 0;
        var team1Player = GetHumans().FirstOrDefault(p => _team1Ids.Contains(p.SteamID) && IsOnPlayingTeam(p));

        if (team1Player != null && ctScore != tScore)
        {
            var winningSide = ctScore > tScore ? CsTeam.CounterTerrorist : CsTeam.Terrorist;
            if (team1Player.Team == winningSide)
            {
                _team1Wins++;
            }
            else
            {
                _team2Wins++;
            }
        }

        if (_mapsPlayed >= _mapsToPlay || _team1Wins >= _mapsToWin || _team2Wins >= _mapsToWin)
        {
            _seriesEndedAt = DateTime.UtcNow;
        }
    }

    private void ClearMatch()
    {
        _matchLoaded = false;
        _seriesEndedAt = null;
        _lockCountdown = -1;
        _team1Ids.Clear();
    }

    private int PlayersNeeded()
    {
        if (Config.PlayersPerTeam > 0)
        {
            return Config.PlayersPerTeam;
        }
        return IsWingman() ? 2 : 5;
    }

    private static bool IsWingman()
    {
        return ConVar.Find("game_mode")?.GetPrimitiveValue<int>() == 2;
    }

    private static List<CCSPlayerController> GetHumans()
    {
        return Utilities.GetPlayers()
            .Where(p => p.IsValid && !p.IsBot && !p.IsHLTV && p.Connected == PlayerConnectedState.Connected)
            .ToList();
    }

    private static bool IsOnPlayingTeam(CCSPlayerController player)
    {
        return player.Team == CsTeam.CounterTerrorist || player.Team == CsTeam.Terrorist;
    }

    private static bool IsWarmup()
    {
        var proxy = Utilities.FindAllEntitiesByDesignerName<CCSGameRulesProxy>("cs_gamerules").FirstOrDefault();
        return proxy?.GameRules?.WarmupPeriod ?? false;
    }
}
